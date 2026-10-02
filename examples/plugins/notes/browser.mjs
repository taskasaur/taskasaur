export default {
  async activate(core) {
    const ui = core.services.require("core.ui");
    const { React, Button, RecordTable } = ui;
    function Notes() {
      const [message, setMessage] = React.useState("");
      return React.createElement(
        "section",
        { className: "space-y-4" },
        React.createElement(
          "p",
          null,
          "An independently installed plugin using Taskasaur’s shared components.",
        ),
        React.createElement(
          Button,
          {
            onClick: async () => {
              const reply = await core.messages.call("example.notes.count", {});
              setMessage(`${reply.count} notes synchronized to the server`);
            },
          },
          "Count server notes",
        ),
        React.createElement("p", { role: "status" }, message),
        React.createElement(RecordTable, {
          collection: "example_notes_entries",
        }),
      );
    }
    return ui.registerSurface({
      id: "notes",
      label: "Example notes",
      render: Notes,
    });
  },
};
