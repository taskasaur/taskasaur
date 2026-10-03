import type { Op } from "quill-delta";
import { z } from "zod";
export type OfficeKind = "document" | "spreadsheet" | "presentation";
export interface Slide {
  id: string;
  title: string;
  body: string;
  notes: string;
  background: string;
  color: string;
  image?: string;
}
export interface OfficeDocument {
  format: "taskasaur-office-v1";
  kind: "document";
  ops: Op[];
}
export interface OfficePresentation {
  format: "taskasaur-office-v1";
  kind: "presentation";
  slides: Slide[];
}
export const officeMedia = "application/vnd.taskasaur.office+json";
const safeImage = z
  .string()
  .max(8 * 1024 * 1024)
  .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/);
const slideSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(10000),
  body: z.string().max(200000),
  notes: z.string().max(200000),
  background: z.string().regex(/^#[a-f0-9]{6}$/i),
  color: z.string().regex(/^#[a-f0-9]{6}$/i),
  image: safeImage.optional(),
});
export function validateOffice(
  input: unknown,
): OfficeDocument | OfficePresentation {
  return z
    .discriminatedUnion("kind", [
      z.object({
        format: z.literal("taskasaur-office-v1"),
        kind: z.literal("document"),
        ops: z
          .array(
            z.object({
              insert: z.union([
                z.string().max(1000000),
                z.object({ image: safeImage }),
              ]),
              attributes: z
                .record(
                  z.union([z.string().max(10000), z.number(), z.boolean()]),
                )
                .optional(),
            }),
          )
          .max(100000),
      }),
      z.object({
        format: z.literal("taskasaur-office-v1"),
        kind: z.literal("presentation"),
        slides: z.array(slideSchema).min(1).max(500),
      }),
    ])
    .parse(input);
}
export const newSlide = (): Slide => ({
  id: crypto.randomUUID(),
  title: "New slide",
  body: "",
  notes: "",
  background: "#ffffff",
  color: "#172033",
});
export async function exportDocument(ops: Op[]) {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ExternalHyperlink,
    HeadingLevel,
  } = await import("docx");
  const paragraphs: InstanceType<typeof Paragraph>[] = [];
  let runs: Array<
    InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>
  > = [];
  for (const op of ops) {
    if (typeof op.insert !== "string") continue;
    const parts = op.insert.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) {
        const text = new TextRun({
          text: parts[i],
          bold: Boolean(op.attributes?.bold),
          italics: Boolean(op.attributes?.italic),
          underline: op.attributes?.underline ? {} : undefined,
          strike: Boolean(op.attributes?.strike),
        });
        runs.push(
          typeof op.attributes?.link === "string" &&
            /^https?:\/\//i.test(op.attributes.link)
            ? new ExternalHyperlink({
                link: op.attributes.link,
                children: [text],
              })
            : text,
        );
      }
      if (i < parts.length - 1) {
        const heading = Number(op.attributes?.header);
        paragraphs.push(
          new Paragraph({
            children: runs,
            heading:
              heading === 1
                ? HeadingLevel.HEADING_1
                : heading === 2
                  ? HeadingLevel.HEADING_2
                  : undefined,
            bullet: op.attributes?.list ? { level: 0 } : undefined,
          }),
        );
        runs = [];
      }
    }
  }
  if (runs.length) paragraphs.push(new Paragraph({ children: runs }));
  return Packer.toBlob(new Document({ sections: [{ children: paragraphs }] }));
}
export async function exportPresentation(slides: Slide[]) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "Taskasaur";
  for (const item of slides) {
    const slide = deck.addSlide();
    slide.background = { color: item.background.slice(1) };
    slide.addText(item.title, {
      x: 0.6,
      y: 0.5,
      w: 12.1,
      h: 1,
      fontSize: 32,
      bold: true,
      color: item.color.slice(1),
      breakLine: false,
    });
    slide.addText(item.body, {
      x: 0.6,
      y: 1.8,
      w: item.image ? 7 : 12.1,
      h: 4.7,
      fontSize: 22,
      color: item.color.slice(1),
      breakLine: false,
      fit: "shrink",
    });
    if (item.image)
      slide.addImage({ data: item.image, x: 8, y: 2, w: 4.5, h: 3.5 });
    slide.addNotes(item.notes);
  }
  return (await deck.write({ outputType: "blob" })) as Blob;
}
