import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import type { Value } from "../field-types";
import { invariant, CoreError } from "./errors";
type Data = Record<string, Value>;
export function calendarInstant(
  value: string,
  timezone?: string | null,
  floatingZone = "UTC",
) {
  try {
    if (value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value))
      return Temporal.Instant.from(value).epochMilliseconds;
    const plain =
      value.length === 10
        ? Temporal.PlainDate.from(value).toPlainDateTime()
        : Temporal.PlainDateTime.from(value);
    return plain.toZonedDateTime(timezone || floatingZone, {
      disambiguation: "compatible",
    }).epochMilliseconds;
  } catch {
    throw new CoreError(
      "VALIDATION_FAILED",
      "Invalid calendar date or IANA time zone",
    );
  }
}
export function durationSeconds(value: string) {
  try {
    const duration = Temporal.Duration.from(value);
    invariant(
      !duration.years && !duration.months,
      "VALIDATION_FAILED",
      "Calendar durations use weeks, days, hours, minutes and seconds",
    );
    return duration.total({ unit: "seconds" });
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("VALIDATION_FAILED", "Invalid calendar duration");
  }
}
export function validateCalendar(data: Data) {
  const start = String(data.dtstart),
    zone = data.timezone ? String(data.timezone) : null;
  invariant(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/.test(start),
    "VALIDATION_FAILED",
    "DTSTART requires an iCalendar date, floating time or UTC time",
  );
  const instant = calendarInstant(start, zone);
  invariant(
    !(data.dtend && data.duration),
    "VALIDATION_FAILED",
    "DTEND and DURATION are mutually exclusive",
  );
  invariant(
    !(zone && (start.length === 10 || start.endsWith("Z"))),
    "VALIDATION_FAILED",
    "TZID applies only to local date-time values",
  );
  if (data.dtend) {
    invariant(
      (String(data.dtend).length === 10) === (start.length === 10),
      "VALIDATION_FAILED",
      "DTEND must use the DTSTART value type",
    );
    invariant(
      calendarInstant(String(data.dtend), zone) > instant,
      "VALIDATION_FAILED",
      "DTEND must follow DTSTART",
    );
  }
  if (data.duration)
    invariant(
      durationSeconds(String(data.duration)) > 0,
      "VALIDATION_FAILED",
      "Event duration must be positive",
    );
  if (data.rrule) {
    try {
      const rule = ICAL.Recur.fromString(String(data.rrule));
      invariant(
        Boolean(rule.freq) && !(rule.count && rule.until),
        "VALIDATION_FAILED",
        "RRULE needs FREQ and cannot combine COUNT and UNTIL",
      );
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("VALIDATION_FAILED", "Invalid recurrence rule");
    }
  }
  for (const key of ["exdates", "rdates"])
    if (data[key] != null) {
      invariant(
        Array.isArray(data[key]),
        "VALIDATION_FAILED",
        `${key} must be an array`,
      );
      for (const value of data[key] as Value[])
        calendarInstant(String(value), zone);
    }
}
export function validateReminder(data: Data) {
  if (data.action === "DISPLAY" || data.action === "EMAIL")
    invariant(
      Boolean(data.description),
      "VALIDATION_FAILED",
      "DESCRIPTION is required for this action",
    );
  if (data.action === "EMAIL")
    invariant(
      Boolean(data.summary) &&
        Array.isArray(data.attendees) &&
        data.attendees.length > 0,
      "VALIDATION_FAILED",
      "EMAIL requires SUMMARY and ATTENDEE",
    );
  invariant(
    (data.repeat != null) === (data.duration != null),
    "VALIDATION_FAILED",
    "REPEAT and DURATION must occur together",
  );
  if (data.duration)
    invariant(
      durationSeconds(String(data.duration)) > 0,
      "VALIDATION_FAILED",
      "Repeat duration must be positive",
    );
  const trigger = String(data.trigger);
  if (/^-?P/.test(trigger)) {
    durationSeconds(trigger);
    invariant(
      data.parent_id,
      "VALIDATION_FAILED",
      "Relative triggers require a parent event or task",
    );
  } else
    invariant(
      trigger.endsWith("Z") && Number.isFinite(calendarInstant(trigger)),
      "VALIDATION_FAILED",
      "Absolute triggers must be UTC instants",
    );
}
export function eventComponent(data: Data) {
  const calendar = new ICAL.Component("vcalendar"),
    component = new ICAL.Component("vevent");
  calendar.addSubcomponent(component);
  component.addPropertyWithValue("uid", String(data.uid));
  component.addPropertyWithValue(
    "dtstamp",
    ICAL.Time.fromString(
      String(data.dtstamp)
        .replace(/\.\d+(Z|\+00:00)$/, "Z")
        .replace(/\+00:00$/, "Z"),
      undefined,
    ),
  );
  const addTime = (name: string, value: Value) => {
    const property = new ICAL.Property(name);
    property.setValue(ICAL.Time.fromString(String(value), undefined));
    if (
      data.timezone &&
      String(value).length > 10 &&
      !String(value).endsWith("Z")
    )
      property.setParameter("tzid", String(data.timezone));
    component.addProperty(property);
  };
  addTime("dtstart", data.dtstart);
  if (data.dtend) addTime("dtend", data.dtend);
  if (data.recurrence_id) addTime("recurrence-id", data.recurrence_id);
  if (data.duration)
    component.addPropertyWithValue(
      "duration",
      ICAL.Duration.fromSeconds(durationSeconds(String(data.duration))),
    );
  for (const key of [
    "summary",
    "description",
    "location",
    "status",
    "organizer",
    "url",
    "transp",
  ])
    if (data[key]) component.addPropertyWithValue(key, String(data[key]));
  if (data.sequence != null)
    component.addPropertyWithValue("sequence", data.sequence);
  if (data.rrule)
    component.addPropertyWithValue(
      "rrule",
      ICAL.Recur.fromString(String(data.rrule)),
    );
  for (const [key, property] of [
    ["exdates", "exdate"],
    ["rdates", "rdate"],
  ])
    if (Array.isArray(data[key]))
      for (const value of data[key] as Value[]) addTime(property, value);
  if (Array.isArray(data.attendees))
    for (const value of data.attendees)
      component.addPropertyWithValue("attendee", String(value));
  if (Array.isArray(data.alarms))
    for (const raw of data.alarms) {
      const alarm = new ICAL.Component(raw as never);
      invariant(
        alarm.name === "valarm",
        "VALIDATION_FAILED",
        "Expected a VALARM component",
      );
      component.addSubcomponent(alarm);
    }
  return component;
}
export interface Occurrence {
  key: string;
  start: string;
  end: string;
  allDay: boolean;
  data: Data;
}
export function calendarOccurrences(
  records: Data[],
  from: number,
  to: number,
  floatingZone = "UTC",
  limit = 1000,
): Occurrence[] {
  invariant(
    to > from && to - from <= 366 * 86400000,
    "VALIDATION_FAILED",
    "Choose a calendar range of at most one year",
  );
  const output: Occurrence[] = [],
    overrides = new Map(
      records
        .filter((r) => r.recurrence_id)
        .map((r) => [String(r.uid) + ":" + r.recurrence_id, r]),
    );
  for (const data of records.filter(
    (r) => !r.recurrence_id && r.status !== "CANCELLED",
  )) {
    validateCalendar(data);
    const iterator = new ICAL.Event(eventComponent(data)).iterator();
    let count = 0,
      time;
    const start = calendarInstant(
      String(data.dtstart),
      data.timezone ? String(data.timezone) : null,
      floatingZone,
    );
    const duration = data.dtend
      ? calendarInstant(
          String(data.dtend),
          data.timezone ? String(data.timezone) : null,
          floatingZone,
        ) - start
      : data.duration
        ? durationSeconds(String(data.duration)) * 1000
        : String(data.dtstart).length === 10
          ? 86400000
          : 0;
    while ((time = iterator.next())) {
      invariant(
        ++count <= 50000,
        "RECURRENCE_LIMIT",
        "Recurrence expansion exceeds its budget; narrow or simplify the rule",
      );
      const original = time.toString(),
        epoch = calendarInstant(
          original,
          data.timezone ? String(data.timezone) : null,
          floatingZone,
        );
      if (epoch > to) break;
      const item = overrides.get(String(data.uid) + ":" + original) ?? data;
      if (item.status === "CANCELLED") continue;
      const actual =
        item === data
          ? epoch
          : calendarInstant(
              String(item.dtstart),
              item.timezone ? String(item.timezone) : null,
              floatingZone,
            );
      const end =
        item !== data && item.dtend
          ? calendarInstant(
              String(item.dtend),
              item.timezone ? String(item.timezone) : null,
              floatingZone,
            )
          : actual + duration;
      if (actual < to && Math.max(actual, end) >= from)
        output.push({
          key: String(data.uid) + ":" + original,
          start: new Date(actual).toISOString(),
          end: new Date(end).toISOString(),
          allDay: String(item.dtstart).length === 10,
          data: item,
        });
      invariant(
        output.length <= limit,
        "RECURRENCE_LIMIT",
        "Too many events in the selected range",
      );
    }
  }
  return output.sort((a, b) => a.start.localeCompare(b.start));
}
export function reminderTimes(
  reminder: Data,
  parent: Data | undefined,
  from: number,
  to: number,
  floatingZone = "UTC",
) {
  if (!reminder.enabled || reminder.acknowledged_at) return [];
  if (reminder.snoozed_until) {
    const time = Date.parse(String(reminder.snoozed_until));
    return time >= from && time <= to ? [time] : [];
  }
  const trigger = String(reminder.trigger),
    times: number[] = [];
  if (/^-?P/.test(trigger)) {
    invariant(parent, "NOT_FOUND", "Reminder parent is unavailable");
    const offset = durationSeconds(trigger) * 1000;
    if (parent.dtstart)
      for (const occurrence of calendarOccurrences(
        [parent],
        from - offset - 86400000,
        to - offset + 86400000,
        floatingZone,
      ))
        times.push(
          Date.parse(
            reminder.related === "END" ? occurrence.end : occurrence.start,
          ) + offset,
        );
    else {
      const anchor =
        reminder.related === "END"
          ? (parent.due_at ?? parent.due_date)
          : (parent.started_at ?? parent.start_at ?? parent.start_date);
      invariant(
        anchor,
        "VALIDATION_FAILED",
        "Task has no time for this relative alarm",
      );
      times.push(calendarInstant(String(anchor), null, floatingZone) + offset);
    }
  } else times.push(calendarInstant(trigger));
  const repeated: number[] = [];
  for (const time of times)
    for (let i = 0; i <= Number(reminder.repeat ?? 0); i++) {
      const next =
        time +
        i *
          (reminder.duration
            ? durationSeconds(String(reminder.duration)) * 1000
            : 0);
      if (next >= from && next <= to) repeated.push(next);
    }
  return repeated;
}
