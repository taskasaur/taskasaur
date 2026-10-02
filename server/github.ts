import { Octokit } from "@octokit/rest";
import { randomUUID } from "node:crypto";
import type { Repository } from "./repository";
import type { CredentialBroker } from "./credentials";
import type { Principal, ResourceRecord } from "../packages/plugin-sdk";
import { operationUuid } from "./runner-dispatch";
import { CoreError, invariant } from "../packages/core/errors";
import { routerFor } from "./api";
export class GithubService {
  constructor(
    private repo: Repository,
    private broker: CredentialBroker,
  ) {}
  async sync(actor: Principal, id: string) {
    await this.repo.requirePlugin(actor, "connector-github");
    const connection = await this.repo.get(actor, id);
    invariant(
      connection.collection === "github_connections",
      "VALIDATION_FAILED",
      "Expected a GitHub repository",
    );
    const owner = String(connection.data.owner),
      repository = String(connection.data.repository);
    invariant(
      /^[a-zA-Z0-9_.-]+$/.test(owner) && /^[a-zA-Z0-9_.-]+$/.test(repository),
      "VALIDATION_FAILED",
      "Invalid repository name",
    );
    return this.broker.use(
      actor,
      String(connection.data.credential_id),
      "connector-github",
      "https://api.github.com",
      "github.issues",
      async (secret) => {
        const api = new Octokit({
          auth: secret.accessToken ?? secret.apiKey,
          request: { timeout: 15000 },
        });
        let count = 0;
        for (let page = 1; page <= 20; page++) {
          const response = await api.issues.listForRepo({
            owner,
            repo: repository,
            state: "all",
            sort: "updated",
            direction: "desc",
            per_page: 100,
            page,
          });
          for (const issue of response.data) {
            if (issue.pull_request) continue;
            const resourceId = operationUuid(`${id}:issue:${issue.id}`);
            let existing: ResourceRecord | undefined;
            try {
              existing = await this.repo.get(actor, resourceId);
            } catch (e) {
              if (!(e instanceof CoreError && e.kind === "NOT_FOUND")) throw e;
            }
            await this.repo.mutate(actor, {
              id: randomUUID(),
              resourceId,
              pluginId: "connector-github",
              collection: "github_issues",
              operation: "put",
              baseRevision: existing?.revision ?? 0,
              createdAt: new Date().toISOString(),
              data: {
                ...existing?.data,
                connection_id: id,
                number: issue.number,
                title: issue.title,
                body: issue.body ?? "",
                state: issue.state,
                url: issue.html_url,
                labels: issue.labels.map((label) =>
                  typeof label === "string" ? label : (label.name ?? ""),
                ),
                provider_updated_at: issue.updated_at,
              },
            });
            count++;
          }
          if (response.data.length < 100) break;
        }
        return { count };
      },
    );
  }
  async createTask(actor: Principal, id: string) {
    invariant(
      await this.repo.featureEnabled(actor, "connector-github", "taskLinks"),
      "FEATURE_DISABLED",
      "Enable task links for the GitHub plugin",
    );
    await this.repo.requirePlugin(actor, "connector-github");
    await this.repo.requirePlugin(actor, "tasks");
    const issue = await this.repo.get(actor, id);
    invariant(
      issue.collection === "github_issues",
      "VALIDATION_FAILED",
      "Expected an issue",
    );
    if (issue.data.task_id)
      return this.repo.get(actor, String(issue.data.task_id));
    const taskId = operationUuid(id + ":task"),
      router = await routerFor(this.repo, actor),
      mutationId = operationUuid(id + ":create-task");
    const result = await router.receive(
      {
        jsonrpc: "2.0",
        id: mutationId,
        method: "tasks.put",
        params: {
          id: mutationId,
          resourceId: taskId,
          pluginId: "tasks",
          collection: "tasks",
          operation: "put",
          baseRevision: 0,
          createdAt: new Date(0).toISOString(),
          data: {
            title: String(issue.data.title),
            description: `${issue.data.body ?? ""}\n\n${issue.data.url ?? ""}`,
            status: issue.data.state === "closed" ? "done" : "open",
          },
        },
      },
      {
        principal: {
          ...actor,
          pluginId: "connector-github",
          permissions: ["tasks.write"],
        },
        signal: AbortSignal.timeout(30000),
      },
    );
    invariant(
      result && "result" in result,
      "COMMAND_FAILED",
      "Task could not be created",
    );
    await this.repo.mutate(actor, {
      id: randomUUID(),
      resourceId: id,
      pluginId: "connector-github",
      collection: "github_issues",
      operation: "put",
      baseRevision: issue.revision,
      createdAt: new Date().toISOString(),
      data: { ...issue.data, task_id: taskId },
    });
    return result.result;
  }
}
