export default {
  async activate(core) {
    return core.messages.handle(
      "example.health.check",
      {
        id: "health_input",
        pluginId: "example.health",
        version: 1,
        name: "Health",
        fields: [],
      },
      async () => ({ ready: true, runtime: core.runtime }),
    );
  },
};
