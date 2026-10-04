/* Integration only. Document editing and the complete UI are the upstream LibreOffice engine.
 * Based on allotropia/zetajs examples/web-office (MIT); see /office-engine/ZetaJS-LICENSE. */
(async () => {
  const params = new URLSearchParams(location.search),
    session = params.get("taskasaurSession"),
    origin = location.origin;
  if (!session || parent === window) return;
  const send = (type, data = {}) =>
    parent.postMessage({ type, session, ...data }, origin);
  const fail = (error) => {
    document.getElementById("loading").textContent = String(error);
    send("taskasaur.office.error", { message: String(error) });
  };
  try {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
      throw Error(
        "This platform cannot run the local office engine. Open the workspace in a browser or desktop app with shared WebAssembly memory support.",
      );
    const extension = params.get("file_path")?.split(".").at(-1);
    if (!/^(odt|ods|odp|docx|xlsx|pptx|csv|txt)$/i.test(extension ?? ""))
      throw Error("Unsupported office file type");
    const path = "/tmp/office/document." + extension;
    const response = await fetch("/office-release.json");
    if (!response.ok) throw Error("Office release is unavailable");
    const release = await response.json();
    const canvas = document.getElementById("qtcanvas"),
      loading = document.getElementById("loading");
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("keydown", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => e.preventDefault(), {
      passive: false,
    });
    let port,
      loaded = false;
    window.Module = {
      canvas,
      uno_scripts: [
        "/office-engine/zeta.js?v=" + release.version,
        "/office-thread.js",
      ],
      locateFile: (name) => "/office-engine/" + name + "?v=" + release.version,
      mainScriptUrlOrBlob: new Blob(
        [
          "importScripts(" +
            JSON.stringify(
              origin + "/office-engine/soffice.js?v=" + release.version,
            ) +
            ");",
        ],
        { type: "text/javascript" },
      ),
      onAbort: fail,
    };
    window.addEventListener("message", (event) => {
      if (
        event.source !== parent ||
        event.origin !== origin ||
        event.data?.session !== session
      )
        return;
      const message = event.data;
      if (message.type === "taskasaur.office.bytes" && !loaded && port) {
        try {
          if (
            !(message.bytes instanceof ArrayBuffer) ||
            message.bytes.byteLength > 256 * 1024 * 1024
          )
            throw Error("Office files must be at most 256 MB");
          FS.mkdirTree("/tmp/office");
          FS.writeFile(path, new Uint8Array(message.bytes));
          loaded = true;
          port.postMessage({ cmd: "open", path });
        } catch (e) {
          fail(e);
        }
      }
      if (message.type === "taskasaur.office.save" && loaded && port)
        port.postMessage({ cmd: "save", requestId: message.requestId });
    });
    const script = document.createElement("script");
    script.src = "/office-engine/soffice.js?v=" + release.version;
    script.onerror = () =>
      fail(
        "The office engine is unavailable. Install its assets before opening a document.",
      );
    script.onload = () =>
      Module.uno_main
        .then((value) => {
          port = value;
          port.onmessage = (event) => {
            const message = event.data;
            if (message.cmd === "ready") send("taskasaur.office.load");
            if (message.cmd === "opened") {
              window.dispatchEvent(new Event("resize"));
              canvas.style.visibility = "visible";
              loading.style.display = "none";
              send("taskasaur.office.opened");
            }
            if (message.cmd === "dirty") send("taskasaur.office.dirty");
            if (message.cmd === "error") fail(message.message);
            if (message.cmd === "saved") {
              try {
                const bytes = FS.readFile(path).slice();
                parent.postMessage(
                  {
                    type: "taskasaur.office.saved",
                    session,
                    requestId: message.requestId,
                    bytes: bytes.buffer,
                  },
                  origin,
                  [bytes.buffer],
                );
              } catch (e) {
                fail(e);
              }
            }
          };
        })
        .catch(fail);
    document.body.appendChild(script);
  } catch (e) {
    fail(e);
  }
})();
