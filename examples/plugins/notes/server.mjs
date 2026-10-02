const input = {
  id: "count_input",
  pluginId: "example.notes",
  name: "Count",
  version: 1,
  fields: [],
};
export default {
  async activate(core) {
    const records = core.services
      .require("core.records")
      .collection("example_notes_entries");
    const disposeCount = core.messages.handle(
      "example.notes.count",
      input,
      async () => ({ count: (await records.list()).length }),
    );
    const disposeEvents = core.messages.subscribe(
      "example_notes_entries.changed",
      async (event) => {
        // Consumers use the event identity as an idempotency key for side effects.
        core.log("Note changed", {
          resourceId: event.data.resourceId,
          eventId: event.id,
        });
      },
    );
    return () => {
      disposeCount();
      disposeEvents();
    };
  },
};
