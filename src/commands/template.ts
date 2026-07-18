import type { CommandOutput } from "../cli/output-schema";
import { renderTemplate, TEMPLATE_EVENT_SCHEMA, UnsupportedTemplateError } from "../probes/render";

export function templateCommand(language: string, ingest: string): CommandOutput {
  try {
    const template = renderTemplate(language, ingest);
    return {
      command: "template",
      data: {
        ...template,
        eventSchema: TEMPLATE_EVENT_SCHEMA,
      },
      hints: [],
      ok: true,
      partial: false,
      schemaVersion: 1,
      scope: {},
      statistics: {},
      warnings: [],
    };
  } catch (error) {
    if (error instanceof UnsupportedTemplateError) {
      return {
        error: {
          code: error.code,
          message: error.message,
        },
        ok: false,
        schemaVersion: 1,
      };
    }
    throw error;
  }
}
