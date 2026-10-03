import {
  canonical,
  keyId,
  publicIdentity,
  randomKey,
  seal,
  sign,
  unseal,
  verify,
  type Identity,
  type PublicIdentity,
} from "./crypto";
import { invariant } from "@taskasaur/platform/core/errors";
export type Role = "owner" | "editor" | "viewer";
export interface Member {
  identity: PublicIdentity;
  userId: string;
  role: Role;
}
export interface PolicyBody {
  workspaceId: string;
  name: string;
  epoch: number;
  previous: string | null;
  owner: PublicIdentity;
  members: Record<string, Member>;
  /** Exact accepted change hashes fence revoked devices, including backdated writes. */
  revoked: Record<string, string[]>;
  sealedKeys: Record<string, string>;
}
export interface Policy extends PolicyBody {
  signature: string;
}
export interface WorkspaceAccess {
  policies: Policy[];
  keys: Record<string, string>;
}
export function currentPolicy(access: WorkspaceAccess) {
  return access.policies.at(-1)!;
}
export async function policyHash(policy: Policy) {
  const { digest, utf8 } = await import("./crypto");
  return digest(utf8.encode(canonical(policy)));
}
export async function validatePolicy(policy: Policy, previous?: Policy) {
  const { signature, ...body } = policy;
  invariant(
    policy.epoch === (previous?.epoch ?? 0) + 1 &&
      policy.workspaceId &&
      Object.keys(policy.members).length <= 1000,
    "INVALID_POLICY",
    "Invalid membership revision",
  );
  invariant(
    policy.previous === (previous ? await policyHash(previous) : null),
    "POLICY_FORK",
    "Membership history does not follow the approved workspace",
  );
  invariant(
    (await keyId(policy.owner.publicKey)) === policy.owner.id &&
      (!previous || canonical(policy.owner) === canonical(previous.owner)),
    "INVALID_POLICY",
    "Workspace owner changed without authorization",
  );
  invariant(
    await verify(policy.owner.publicKey, body, signature),
    "INVALID_SIGNATURE",
    "Membership signature is invalid",
  );
  for (const [id, member] of Object.entries(policy.members)) {
    invariant(
      (await keyId(member.identity.publicKey)) === id &&
        member.identity.id === id &&
        ["owner", "editor", "viewer"].includes(member.role),
      "INVALID_POLICY",
      "Invalid member identity",
    );
    invariant(
      member.role !== "owner" || id === policy.owner.id,
      "INVALID_POLICY",
      "Only the root identity can administer membership",
    );
  }
  invariant(
    policy.members[policy.owner.id]?.role === "owner",
    "INVALID_POLICY",
    "Workspace owner is missing",
  );
}
async function issuePolicy(
  owner: Identity,
  body: Omit<PolicyBody, "sealedKeys">,
  keys: Record<string, string>,
) {
  const sealedKeys: Record<string, string> = {};
  for (const member of Object.values(body.members))
    sealedKeys[member.identity.id] = await seal(
      owner,
      member.identity,
      keys,
      `${body.workspaceId}:${body.epoch}`,
    );
  const value = { ...body, sealedKeys };
  return { ...value, signature: await sign(owner.privateKey, value) };
}
export async function createWorkspaceAccess(
  identity: Identity,
  name: string,
  workspaceId: string = crypto.randomUUID(),
  userId: string = crypto.randomUUID(),
): Promise<WorkspaceAccess> {
  const keys = { "1": randomKey() };
  const policy = await issuePolicy(
    identity,
    {
      workspaceId,
      name,
      epoch: 1,
      previous: null,
      owner: publicIdentity(identity),
      members: {
        [identity.id]: {
          identity: publicIdentity(identity),
          userId,
          role: "owner",
        },
      },
      revoked: {},
    },
    keys,
  );
  return { policies: [policy], keys };
}
export async function approveMember(
  access: WorkspaceAccess,
  owner: Identity,
  request: PublicIdentity,
  role: Role = "editor",
  userId?: string,
) {
  const prior = currentPolicy(access);
  invariant(
    owner.id === prior.owner.id,
    "PERMISSION_DENIED",
    "Workspace owner approval is required",
  );
  invariant(
    (await keyId(request.publicKey)) === request.id && role !== "owner",
    "INVALID_IDENTITY",
    "Invalid pairing request",
  );
  invariant(
    !prior.revoked[request.id],
    "REVOKED",
    "Create a new device identity before pairing again",
  );
  const existing = prior.members[request.id];
  if (existing) {
    invariant(
      existing.role === role &&
        (!userId || existing.userId === userId) &&
        canonical(existing.identity) === canonical(request),
      "MEMBER_ALREADY_EXISTS",
      "Revoke the existing identity and pair a new identity to change its access",
    );
    return access;
  }
  const keys = { ...access.keys, [String(prior.epoch + 1)]: randomKey() };
  const policy = await issuePolicy(
    owner,
    {
      workspaceId: prior.workspaceId,
      name: prior.name,
      epoch: prior.epoch + 1,
      previous: await policyHash(prior),
      owner: prior.owner,
      members: {
        ...prior.members,
        [request.id]: {
          identity: request,
          userId: userId ?? prior.members[owner.id].userId,
          role,
        },
      },
      revoked: prior.revoked,
    },
    keys,
  );
  return { policies: [...access.policies, policy], keys };
}
export async function revokeMember(
  access: WorkspaceAccess,
  owner: Identity,
  deviceId: string,
  acceptedChanges: string[],
) {
  const prior = currentPolicy(access);
  invariant(
    owner.id === prior.owner.id &&
      deviceId !== owner.id &&
      prior.members[deviceId],
    "PERMISSION_DENIED",
    "Only the owner can revoke another device",
  );
  const members = { ...prior.members };
  delete members[deviceId];
  const keys = { ...access.keys, [String(prior.epoch + 1)]: randomKey() };
  const policy = await issuePolicy(
    owner,
    {
      workspaceId: prior.workspaceId,
      name: prior.name,
      epoch: prior.epoch + 1,
      previous: await policyHash(prior),
      owner: prior.owner,
      members,
      revoked: { ...prior.revoked, [deviceId]: acceptedChanges },
    },
    keys,
  );
  return { policies: [...access.policies, policy], keys };
}
export async function acceptPolicies(
  identity: Identity,
  policies: Policy[],
  previous?: WorkspaceAccess,
): Promise<WorkspaceAccess> {
  invariant(
    policies.length > 0 && policies.length <= 10000,
    "INVALID_POLICY",
    "Membership history is missing or too large",
  );
  for (let i = 0; i < policies.length; i++) {
    await validatePolicy(policies[i], policies[i - 1]);
    if (previous?.policies[i])
      invariant(
        canonical(previous.policies[i]) === canonical(policies[i]),
        "POLICY_FORK",
        "Conflicting membership history",
      );
  }
  invariant(
    !previous || policies.length >= previous.policies.length,
    "STALE_POLICY",
    "Membership history cannot go backwards",
  );
  const policy = policies.at(-1)!;
  invariant(
    policy.members[identity.id],
    "REVOKED",
    "This device is not a member of the workspace",
  );
  const keys = (await unseal(
    identity,
    policy.owner,
    policy.sealedKeys[identity.id],
    `${policy.workspaceId}:${policy.epoch}`,
  )) as Record<string, string>;
  return { policies, keys };
}
