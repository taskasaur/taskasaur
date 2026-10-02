import { it, expect } from "vitest";
import {
  calendarImport,
  calendarExport,
  importedReminders,
} from "../packages/core/calendar";
import {
  calendarOccurrences,
  reminderTimes,
} from "../packages/core/calendar-values";
import { validateRecord } from "../packages/field-types";
import { getSchema } from "../packages/core/catalog";
it("round trips minimum events and embedded alarms without inventing optional required fields", () => {
  const input =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTAMP:20261002T000000Z\r\nDTSTART;VALUE=DATE:20261003\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nDESCRIPTION:Wake\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const records = calendarImport(input);
  expect(records[0].summary).toBeNull();
  expect(calendarImport(calendarExport(records))).toEqual(records);
  expect(importedReminders(records[0], crypto.randomUUID())[0].trigger).toBe(
    "-PT5M",
  );
});
it("expands recurrence across DST, exceptions, and repeated relative alarms", () => {
  const event = validateRecord(getSchema("calendar"), {
    uid: "dst",
    dtstamp: "2026-10-02T00:00:00Z",
    dtstart: "2026-10-31T09:00:00",
    dtend: "2026-10-31T10:00:00",
    timezone: "America/New_York",
    rrule: "FREQ=DAILY;COUNT=3",
    exdates: ["2026-11-02T09:00:00"],
  });
  const from = Date.parse("2026-10-30T00:00:00Z"),
    to = Date.parse("2026-11-04T00:00:00Z");
  const occurrences = calendarOccurrences([event], from, to);
  expect(occurrences.map((o) => o.start)).toEqual([
    "2026-10-31T13:00:00.000Z",
    "2026-11-01T14:00:00.000Z",
  ]);
  const reminder = validateRecord(getSchema("reminders"), {
    action: "DISPLAY",
    description: "Soon",
    trigger: "-PT5M",
    parent_id: crypto.randomUUID(),
    repeat: 1,
    duration: "PT1M",
  });
  expect(
    reminderTimes(reminder, event, from, to).map((t) =>
      new Date(t).toISOString(),
    ),
  ).toEqual([
    "2026-10-31T12:55:00.000Z",
    "2026-10-31T12:56:00.000Z",
    "2026-11-01T13:55:00.000Z",
    "2026-11-01T13:56:00.000Z",
  ]);
  expect(() =>
    validateRecord(getSchema("calendar"), {
      ...event,
      dtstart: "2026-02-30T09:00:00",
    }),
  ).toThrow();
});
