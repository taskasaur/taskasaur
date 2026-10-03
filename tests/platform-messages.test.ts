import { describe, expect, it } from "vitest";
import { CloudEvent } from "cloudevents";
import { domainEvent } from "../packages/platform/src/core/messages";

describe("CloudEvents runtime compatibility", () => {
  const principal = {
    workspaceId: "workspace-1",
    pluginId: "tasks",
    userId: "user-1",
    deviceId: "device-1",
    permissions: [],
  };

  it("serializes the shared plugin event envelope on the supported Node runtime", () => {
    const event = domainEvent(
      principal,
      "record.updated",
      "record-1",
      3,
      { title: "Shared task" },
      "operation-1",
    );
    expect(JSON.parse(JSON.stringify(event))).toMatchObject({
      specversion: "1.0",
      id: "operation-1",
      source: "/plugins/tasks",
      type: "taskasaur.record.updated.v1",
      subject: "record-1",
      datacontenttype: "application/json",
      data: {
        workspaceId: "workspace-1",
        resourceId: "record-1",
        revision: 3,
        value: { title: "Shared task" },
      },
    });
  });

  it("retains the library's validation of required event sources", () => {
    expect(() =>
      new CloudEvent({ type: "taskasaur.record.updated.v1", source: "" }),
    ).toThrow();
  });
});
