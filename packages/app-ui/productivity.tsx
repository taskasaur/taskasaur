"use client";
import { useEffect, useState, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Play,
  Square,
  Download,
  Upload,
  Check,
  AlarmClock,
} from "lucide-react";
import type { AppRuntime } from "./runtime";
import { RecordTable } from "./record-table";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import {
  calendarExport,
  calendarImport,
  importedReminders,
} from "../core/calendar";
import { calendarOccurrences } from "../core/calendar-values";
import { field } from "../field-types";
import { FieldInput } from "../ui/fields";
import type { ResourceRecord } from "../plugin-sdk";
export function TasksView({ runtime }: { runtime: AppRuntime }) {
  const [view, setView] = useState("table");
  const tasks =
    useLiveQuery(() => runtime.collection("tasks").list(), [runtime]) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        <Button
          variant={view === "table" ? "secondary" : "ghost"}
          onClick={() => setView("table")}
        >
          Table
        </Button>
        <Button
          variant={view === "board" ? "secondary" : "ghost"}
          onClick={() => setView("board")}
        >
          Board
        </Button>
      </div>
      {view === "table" ? (
        <RecordTable
          runtime={runtime}
          collection="tasks"
          renderActions={(task) => (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Toggle task completion"
              onClick={() =>
                void runtime.collection("tasks").put(
                  {
                    ...task.data,
                    status: task.data.status === "done" ? "open" : "done",
                  },
                  task.id,
                )
              }
            >
              <Check size={14} />
            </Button>
          )}
        />
      ) : (
        <div className="grid md:grid-cols-4 gap-4">
          {["open", "in-progress", "done", "cancelled"].map((status) => (
            <section key={status} className="rounded-xl border bg-muted/30 p-3">
              <h3 className="font-medium mb-3 capitalize">{status}</h3>
              {tasks
                .filter((t) => t.data.status === status)
                .map((task) => (
                  <article
                    className="bg-card rounded-lg border p-3 mb-2"
                    key={task.id}
                  >
                    <p className="font-medium">{String(task.data.title)}</p>
                    <select
                      className="core-select mt-3"
                      aria-label="Task status"
                      value={status}
                      onChange={(e) =>
                        void runtime
                          .collection("tasks")
                          .put(
                            { ...task.data, status: e.target.value },
                            task.id,
                          )
                      }
                    >
                      {["open", "in-progress", "done", "cancelled"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </article>
                ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
export function TimeView({ runtime }: { runtime: AppRuntime }) {
  const rows =
    useLiveQuery(() => runtime.collection("time").list(), [runtime]) ?? [];
  const running = rows.find((row) => !row.data.ended_at),
    [title, setTitle] = useState(""),
    [kind, setKind] = useState("work"),
    [minutes, setMinutes] = useState(25),
    [tick, setTick] = useState(Date.now()),
    [error, setError] = useState("");
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = running
    ? Math.max(
        0,
        Math.floor(
          ((running.data.paused_at
            ? Date.parse(String(running.data.paused_at))
            : tick) -
            Date.parse(String(running.data.started_at)) -
            Number(running.data.paused_ms ?? "0")) /
            1000,
        ),
      )
    : 0;
  const duration = `${Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((seconds / 60) % 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  async function toggle() {
    try {
      const store = runtime.collection("time");
      if (running)
        await store.put(
          {
            ...running.data,
            ended_at: new Date().toISOString(),
            paused_at: null,
            paused_ms: String(
              Number(running.data.paused_ms ?? "0") +
                (running.data.paused_at
                  ? Date.now() - Date.parse(String(running.data.paused_at))
                  : 0),
            ),
          },
          running.id,
        );
      else
        await store.put({
          title: title || "Untitled activity",
          started_at: new Date().toISOString(),
          kind,
          target_seconds: kind === "work" ? null : minutes * 60,
        });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function pause() {
    if (!running) return;
    const paused = running.data.paused_at;
    await runtime.collection("time").put(
      {
        ...running.data,
        paused_at: paused ? null : new Date().toISOString(),
        paused_ms: String(
          Number(running.data.paused_ms ?? "0") +
            (paused ? Date.now() - Date.parse(String(paused)) : 0),
        ),
      },
      running.id,
    );
  }
  useEffect(() => {
    if (
      !running ||
      running.data.paused_at ||
      !running.data.target_seconds ||
      seconds < Number(running.data.target_seconds)
    )
      return;
    void (async () => {
      await toggle();
      await runtime.collection("notifications").put({
        title:
          running.data.kind === "break"
            ? "Break finished"
            : "Focus session finished",
        body: String(running.data.title),
        resource_id: running.id,
        dedupe_key: `timer:${running.id}`,
      });
      if ("Notification" in window && Notification.permission === "granted")
        new Notification("Timer finished", {
          body: String(running.data.title),
        });
    })().catch((e) => setError(e.message));
  }, [running?.id, seconds]);
  return (
    <div className="space-y-6">
      <div className="timer-card">
        <div>
          <p className="text-sm text-muted-foreground">
            {running ? String(running.data.title) : "Ready to track"}
          </p>
          <p className="text-4xl font-mono tracking-tight mt-2">{duration}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!running && (
            <>
              <select
                className="core-select"
                aria-label="Timer kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="work">Track time</option>
                <option value="focus">Focus</option>
                <option value="break">Break</option>
              </select>
              {kind !== "work" && (
                <label className="text-sm">
                  Minutes
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                  />
                </label>
              )}
            </>
          )}
          <Input
            aria-label="Activity name"
            placeholder="What are you working on?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={Boolean(running)}
          />
          <Button onClick={() => void toggle()}>
            {running ? <Square size={16} /> : <Play size={16} />}{" "}
            {running ? "Stop" : "Start"}
          </Button>
          {running && (
            <Button
              variant="outline"
              onClick={() => void pause().catch((e) => setError(e.message))}
            >
              {running.data.paused_at ? "Resume" : "Pause"}
            </Button>
          )}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <RecordTable runtime={runtime} collection="time" />
    </div>
  );
}
export function CalendarView({ runtime }: { runtime: AppRuntime }) {
  const [error, setError] = useState(""),
    [view, setView] = useState("table"),
    [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const projection = useMemo(
    () => ({
      id: "agenda",
      pluginId: "calendar",
      name: "Agenda",
      version: 1,
      fields: [
        field("summary", "Title"),
        field("start", "Start", "timestamp with time zone"),
        field("end", "End", "timestamp with time zone"),
        field("all_day", "All day", "boolean"),
        field("location", "Location"),
      ],
    }),
    [],
  );
  const projectedStore = useMemo(
    () => ({
      list: async () => {
        const rows = await runtime.collection("calendar").list(),
          from = Date.parse(date + "T00:00:00Z"),
          to = from + 31 * 86400000;
        try {
          return calendarOccurrences(
            rows.map((r) => r.data),
            from,
            to,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ).map((occurrence) => ({
            ...rows.find((r) => r.data.uid === occurrence.data.uid)!,
            id: occurrence.key,
            data: {
              summary: occurrence.data.summary,
              start: occurrence.start,
              end: occurrence.end,
              all_day: occurrence.allDay,
              location: occurrence.data.location,
            },
          }));
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
          return [];
        }
      },
      put: async () => {
        throw new Error("Edit the event in the table");
      },
      delete: async () => {
        throw new Error("Edit the event in the table");
      },
    }),
    [runtime, date],
  );
  const exportEvents = async () => {
    const rows = await runtime.collection("calendar").list();
    download(
      "calendar.ics",
      new Blob([calendarExport(rows.map((r) => r.data))], {
        type: "text/calendar",
      }),
    );
  };
  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        <Button
          variant={view === "table" ? "secondary" : "ghost"}
          onClick={() => setView("table")}
        >
          Events table
        </Button>
        <Button
          variant={view === "agenda" ? "secondary" : "ghost"}
          onClick={() => setView("agenda")}
        >
          Agenda
        </Button>
        {view === "agenda" && (
          <FieldInput
            definition={field("agenda_date", "Agenda from", "date")}
            value={date}
            onChange={(value) => setDate(String(value))}
          />
        )}
      </div>
      {view === "agenda" ? (
        <RecordTable
          runtime={runtime}
          collection="calendar"
          viewKey="calendar.agenda"
          schemaOverride={projection}
          storeOverride={projectedStore}
          readOnly
        />
      ) : (
        <RecordTable
          runtime={runtime}
          collection="calendar"
          toolbar={
            <>
              <Button variant="outline" onClick={() => void exportEvents()}>
                <Download size={14} />
                Export
              </Button>
              <label className="upload-button">
                <Upload size={14} />
                Import
                <input
                  type="file"
                  accept=".ics,text/calendar"
                  hidden
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const existing = await runtime
                        .collection("calendar")
                        .list();
                      for (const data of calendarImport(await file.text())) {
                        const old = existing.find(
                          (r) =>
                            r.data.uid === data.uid &&
                            r.data.recurrence_id === data.recurrence_id,
                        );
                        const event = await runtime
                          .collection("calendar")
                          .put(data, old?.id);
                        if (!old && runtime.registry.enabled("reminders"))
                          for (const alarm of importedReminders(data, event.id))
                            await runtime.collection("reminders").put(alarm);
                      }
                      setError("");
                    } catch (error) {
                      setError(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            </>
          }
        />
      )}
      {error && (
        <p role="alert" className="error-banner mt-3">
          {error}
        </p>
      )}
    </>
  );
}
export function RemindersView({ runtime }: { runtime: AppRuntime }) {
  async function update(row: ResourceRecord, snooze: boolean) {
    await runtime.collection("reminders").put(
      {
        ...row.data,
        ...(snooze
          ? {
              snoozed_until: new Date(Date.now() + 10 * 60000).toISOString(),
              acknowledged_at: null,
            }
          : { acknowledged_at: new Date().toISOString() }),
      },
      row.id,
    );
  }
  return (
    <RecordTable
      runtime={runtime}
      collection="reminders"
      renderActions={(row) => (
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Snooze ten minutes"
            onClick={() => void update(row, true)}
          >
            <AlarmClock size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss reminder"
            onClick={() => void update(row, false)}
          >
            <Check size={14} />
          </Button>
        </>
      )}
    />
  );
}
export function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
