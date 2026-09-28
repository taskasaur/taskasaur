import { describe, expect, it } from "vitest";
import { CSDBDatabase } from "@/lib/csdb";

const source = `--- csdb
format: CSDB
version: 1
name: adapter-test
tables: [projects, tasks]

--- table:projects:schema
name: projects
columns:
  id: integer
  name: text
required: [id]
primary_key:
  columns: [id]

--- table:projects:data
id,name
1,First
2,Second

--- table:tasks:schema
name: tasks
columns:
  id: integer
  project_id: integer
  title: text
required: [id]
primary_key:
  columns: [id]
foreign_keys:
  - name: task_project
    columns: [project_id]
    references:
      table: projects
      columns: [id]
    relationship: project

--- table:tasks:data
id,project_id,title
1,1,Plan
2,2,Build
3,,Unassigned
`;

describe("CSDB renderer adapter", () => {
  it("reads current rows after insert, update, delete, and failed mutations", () => {
    const db = CSDBDatabase.parse(source);
    db.table("tasks").insert({ id: 4, project_id: 1, title: "Review" });
    expect(db.table("tasks").byPrimaryKey(4)?.title).toBe("Review");

    db.table("tasks").where({ id: 4 }).update({ title: "Ship" });
    expect(db.sql("SELECT title FROM tasks WHERE id = ?", [4])).toEqual([{ title: "Ship" }]);
    expect(() => db.table("tasks").where({ id: 4 }).update({ project_id: 99 })).toThrow();
    expect(db.table("tasks").byPrimaryKey(4)).toEqual({ id: 4, project_id: 1, title: "Ship" });

    db.table("tasks").where({ id: 4 }).delete();
    expect(db.table("tasks").byPrimaryKey(4)).toBeUndefined();
    expect(db.table("tasks").all()).toHaveLength(3);
  });

  it("applies filters before limits and resolves current relationship rows", () => {
    const db = CSDBDatabase.parse(source);
    expect(db.table("tasks").where({ project_id: 2 }).first()?.id).toBe(2);
    expect(db.table("tasks").orderBy("id", "desc").first()?.id).toBe(3);
    expect(db.table("tasks").limit(0).all()).toEqual([]);

    db.table("projects").where({ id: 2 }).update({ name: "Updated" });
    expect(db.table("tasks").join("project").where({ id: 2 }).first()?.project).toEqual({ id: 2, name: "Updated" });
    expect(db.table("tasks").join("project").where({ id: 3 }).first()?.project).toBeNull();
    expect(db.sql("SELECT p.name FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = 2")).toEqual([{ "p.name": "Updated" }]);
  });

  it("round-trips Unicode and section-like lines inside CSV fields", () => {
    const db = CSDBDatabase.parse(source);
    const title = 'Hawaiʻi 🌺\n--- table:fake:schema\n"Quoted", text';
    db.table("tasks").where({ id: 1 }).update({ title });

    const restored = CSDBDatabase.parse(db.toString());
    expect(restored.table("tasks").byPrimaryKey(1)?.title).toBe(title);
    expect(restored.document.tableOrder).toEqual(["projects", "tasks"]);
  });
});
