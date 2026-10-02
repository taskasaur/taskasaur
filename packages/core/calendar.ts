import ICAL from "ical.js";
import type { Value } from "../field-types";
import { validateRecord } from "../field-types";
import { getSchema } from "./catalog";
import { invariant } from "./errors";
import { eventComponent } from "./calendar-values";
export function calendarImport(input: string): Record<string, Value>[] {
  const calendar = new ICAL.Component(ICAL.parse(input));
  invariant(
    calendar.name === "vcalendar",
    "VALIDATION_FAILED",
    "Expected VCALENDAR",
  );
  return calendar.getAllSubcomponents("vevent").map((component) => {
    const event = new ICAL.Event(component),
      start = component.getFirstProperty("dtstart");
    const uid = component.getFirstPropertyValue("uid"),
      stamp = component.getFirstPropertyValue("dtstamp");
    invariant(
      uid && stamp && start,
      "VALIDATION_FAILED",
      "VEVENT requires UID, DTSTAMP, and DTSTART",
    );
    const result: Record<string, Value> = {
      uid: String(uid),
      dtstamp: String(stamp),
      dtstart: event.startDate.toString(),
      summary: event.summary || null,
      description: event.description || null,
      location: event.location || null,
      timezone: String(start.getParameter("tzid") ?? "") || null,
    };
    const end = component.getFirstPropertyValue("dtend"),
      duration = component.getFirstPropertyValue("duration"),
      rule = component.getFirstPropertyValue("rrule");
    if (end) result.dtend = String(end);
    if (duration) result.duration = String(duration);
    if (rule) result.rrule = String(rule);
    result.exdates = component
      .getAllProperties("exdate")
      .flatMap((property) => property.getValues().map(String));
    result.rdates = component
      .getAllProperties("rdate")
      .flatMap((property) => property.getValues().map(String));
    result.alarms = component
      .getAllSubcomponents("valarm")
      .map((alarm) => alarm.toJSON());
    for (const key of [
      "recurrence-id",
      "organizer",
      "url",
      "status",
      "transp",
      "sequence",
    ]) {
      const value = component.getFirstPropertyValue(key);
      if (value != null)
        result[key.replace("-", "_")] =
          key === "sequence" ? Number(value) : String(value);
    }
    result.attendees = component
      .getAllProperties("attendee")
      .map((property) => String(property.getFirstValue()));
    return validateRecord(getSchema("calendar"), result);
  });
}
export function calendarExport(records: Record<string, Value>[]) {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue(
    "prodid",
    "-//Taskasaur//Plugin Calendar 1.0//EN",
  );
  for (const input of records) {
    const data = validateRecord(getSchema("calendar"), input),
      component = eventComponent(data);
    calendar.addSubcomponent(component);
  }
  return calendar.toString();
}
export function importedReminders(
  event: Record<string, Value>,
  parentId: string,
) {
  return (Array.isArray(event.alarms) ? event.alarms : []).map((raw) => {
    const alarm = new ICAL.Component(raw as never),
      trigger = alarm.getFirstProperty("trigger");
    invariant(trigger, "VALIDATION_FAILED", "VALARM needs TRIGGER");
    const data: Record<string, Value> = {
      action: String(alarm.getFirstPropertyValue("action")),
      trigger: String(trigger.getFirstValue()),
      parent_id: parentId,
      related: String(trigger.getParameter("related") ?? "START"),
    };
    for (const key of ["description", "summary", "duration", "repeat"]) {
      const value = alarm.getFirstPropertyValue(key);
      if (value != null)
        data[key] = key === "repeat" ? Number(value) : String(value);
    }
    data.attendees = alarm
      .getAllProperties("attendee")
      .map((property) => String(property.getFirstValue()));
    return validateRecord(getSchema("reminders"), data);
  });
}
