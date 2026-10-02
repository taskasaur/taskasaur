import { randomUUID } from "node:crypto";
import type { Repository } from "./repository";
import type { Principal } from "../packages/plugin-sdk";
import { invariant } from "../packages/core/errors";
import { domainEvent } from "../packages/core/messages";
export class AccessService {
  constructor(private repo: Repository) {}
  async members(actor: Principal) {
    await this.repo.membership(actor);
    return (
      await this.repo.db.query(
        "SELECT m.user_id,m.role,u.email FROM taskasaur.memberships m LEFT JOIN auth.users u ON u.id=m.user_id WHERE m.workspace_id=$1",
        [actor.workspaceId],
      )
    ).rows;
  }
  async addMember(actor: Principal, email: string, role: string) {
    invariant(
      (await this.repo.membership(actor, true)) === "owner",
      "PERMISSION_DENIED",
      "Only the workspace owner manages members",
    );
    invariant(
      ["editor", "viewer"].includes(role),
      "VALIDATION_FAILED",
      "Choose editor or viewer",
    );
    const user = (
      await this.repo.db.query<{ id: string }>(
        "SELECT id FROM auth.users WHERE lower(email)=lower($1)",
        [email],
      )
    ).rows[0];
    invariant(
      user,
      "NOT_FOUND",
      "This person must create an account on this server first",
    );
    invariant(
      user.id !== actor.userId,
      "PERMISSION_DENIED",
      "Owner access cannot be replaced",
    );
    await this.repo.db.query(
      "INSERT INTO taskasaur.memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role",
      [actor.workspaceId, user.id, role],
    );
    await this.repo.db.query(
      "UPDATE taskasaur.workspaces SET access_epoch=access_epoch+1 WHERE id=$1",
      [actor.workspaceId],
    );
    return { userId: user.id };
  }
  async removeMember(actor: Principal, userId: string) {
    invariant(
      (await this.repo.membership(actor, true)) === "owner",
      "PERMISSION_DENIED",
      "Only the workspace owner manages members",
    );
    invariant(
      userId !== actor.userId,
      "PERMISSION_DENIED",
      "The workspace owner cannot be removed",
    );
    await this.repo.db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM taskasaur.memberships WHERE workspace_id=$1 AND user_id=$2",
        [actor.workspaceId, userId],
      );
      await tx.query(
        "DELETE FROM taskasaur.grants WHERE subject_id=$1 AND resource_id IN(SELECT id FROM taskasaur.resources WHERE workspace_id=$2)",
        [userId, actor.workspaceId],
      );
      await tx.query(
        "UPDATE taskasaur.workspaces SET access_epoch=access_epoch+1 WHERE id=$1",
        [actor.workspaceId],
      );
      await tx.query(
        "UPDATE taskasaur.device_keys SET revoked_at=now() WHERE device_id IN(SELECT id FROM taskasaur.resources WHERE workspace_id=$1 AND owner_id=$2)",
        [actor.workspaceId, userId],
      );
    });
    return { ok: true };
  }
  async grants(actor: Principal, resourceId: string) {
    const resource = await this.repo.authorize(actor, resourceId);
    invariant(
      resource.owner_id === actor.userId,
      "PERMISSION_DENIED",
      "Only the owner can review sharing",
    );
    return (
      await this.repo.db.query(
        "SELECT subject_id,role,expires_at FROM taskasaur.grants WHERE resource_id=$1",
        [resourceId],
      )
    ).rows;
  }
  async grant(
    actor: Principal,
    resourceId: string,
    subjectId: string,
    role: string | null,
    expiresAt: string | null,
  ) {
    const resource = await this.repo.authorize(actor, resourceId, true);
    invariant(
      resource.owner_id === actor.userId,
      "PERMISSION_DENIED",
      "Only the resource owner manages sharing",
    );
    invariant(
      !["credentials", "devices", "workflow_runs", "jobs"].includes(
        resource.collection,
      ),
      "PERMISSION_DENIED",
      "This resource needs its specialized capability grant",
    );
    invariant(
      role === null || ["viewer", "commenter", "editor"].includes(role),
      "VALIDATION_FAILED",
      "Invalid resource role",
    );
    invariant(
      (
        await this.repo.db.query(
          "SELECT user_id FROM taskasaur.memberships WHERE workspace_id=$1 AND user_id=$2",
          [actor.workspaceId, subjectId],
        )
      ).rows.length,
      "PERMISSION_DENIED",
      "Add this person to the workspace first",
    );
    await this.repo.db.transaction(async (tx) => {
      const sequence = (
        await tx.query<{ revision: string }>(
          "UPDATE taskasaur.workspaces SET revision=revision+1,access_epoch=access_epoch+1 WHERE id=$1 RETURNING revision",
          [actor.workspaceId],
        )
      ).rows[0].revision;
      if (role)
        await tx.query(
          "INSERT INTO taskasaur.grants(resource_id,subject_id,role,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(resource_id,subject_id) DO UPDATE SET role=EXCLUDED.role,expires_at=EXCLUDED.expires_at",
          [resourceId, subjectId, role, expiresAt],
        );
      else
        await tx.query(
          "DELETE FROM taskasaur.grants WHERE resource_id=$1 AND subject_id=$2",
          [resourceId, subjectId],
        );
      await tx.query(
        "INSERT INTO taskasaur.changes(workspace_id,sequence,resource_id,event) VALUES($1,$2,$3,$4)",
        [
          actor.workspaceId,
          sequence,
          resourceId,
          JSON.stringify(
            domainEvent(
              { ...actor, pluginId: "access-control" },
              "access.changed",
              resourceId,
              Number(resource.revision),
              { subjectId, role },
              randomUUID(),
            ),
          ),
        ],
      );
    });
    return { ok: true };
  }
}
