/* Taskasaur file adapter for the upstream LibreOffice UNO API.
 * Based on allotropia/zetajs examples/web-office (MIT). No custom document model or editor. */
Module.zetajs.then((zetajs) => {
  const css = zetajs.uno.com.sun.star;
  const desktop = css.frame.Desktop.create(zetajs.getUnoComponentContext());
  const prop = (Name, Value) => new css.beans.PropertyValue({ Name, Value });
  let model,
    changeListener,
    documentListener,
    saving = false;
  zetajs.mainPort.onmessage = (event) => {
    const message = event.data;
    try {
      if (message.cmd === "open") {
        if (
          !/^\/tmp\/office\/document\.(odt|ods|odp|docx|xlsx|pptx|csv|txt)$/i.test(
            message.path,
          )
        )
          throw Error("Invalid document path");
        model = desktop.loadComponentFromURL(
          "file://" + message.path,
          "_blank",
          0,
          [
            prop(
              "MacroExecutionMode",
              css.document.MacroExecMode.NEVER_EXECUTE,
            ),
            prop("UpdateDocMode", css.document.UpdateDocMode.NO_UPDATE),
          ],
        );
        if (!model) throw Error("LibreOffice could not open this file");
        model
          .getCurrentController()
          .getFrame()
          .getContainerWindow().FullScreen = true;
        changeListener = zetajs.unoObject([css.util.XModifyListener], {
          modified: () => {
            if (model.isModified())
              zetajs.mainPort.postMessage({ cmd: "dirty" });
          },
          disposing: () => {},
        });
        model.addModifyListener(changeListener);
        documentListener = zetajs.unoObject(
          [css.document.XDocumentEventListener],
          {
            documentEventOccured: (event) => {
              if (event.EventName === "OnSaveDone" && !saving)
                zetajs.mainPort.postMessage({ cmd: "saved" });
            },
            disposing: () => {},
          },
        );
        model.addDocumentEventListener(documentListener);
        zetajs.mainPort.postMessage({ cmd: "opened" });
      }
      if (message.cmd === "save") {
        if (!model) throw Error("Open a document before saving");
        saving = true;
        try {
          model.store();
        } finally {
          saving = false;
        } // Complete before acknowledging bytes to core.
        zetajs.mainPort.postMessage({
          cmd: "saved",
          requestId: message.requestId,
        });
      }
    } catch (error) {
      zetajs.mainPort.postMessage({ cmd: "error", message: String(error) });
    }
  };
  zetajs.mainPort.postMessage({ cmd: "ready" });
});
