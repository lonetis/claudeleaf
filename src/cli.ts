#!/usr/bin/env node
/**
 * Claudeleaf command-line interface.
 *
 * No configuration is required: run `claudeleaf login` once, then operate on any project
 * by id or name. Commands take only operation arguments.
 */

import process from "node:process";

import { OverleafClient } from "./client.js";
import { Config } from "./config.js";
import { ClaudeleafError } from "./errors.js";

const VALUE_FLAGS = new Set(["count"]);

function parseArgs(args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // End of options: everything after is a positional (e.g. text starting with "--").
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        if (VALUE_FLAGS.has(name) && args[i + 1] !== undefined) {
          flags[name] = args[++i];
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function textArg(value: string | undefined): Promise<string> {
  return value === undefined || value === "-" ? readStdin() : value;
}

const USAGE = `claudeleaf - bring Claude into Overleaf

Usage: claudeleaf <command> [args]

  login                                   sign in via browser, cache the session
  doctor                                  check the session, list projects
  projects                                list all accessible projects
  info <project>                          project metadata
  ls <project> [--all]                    list documents (--all includes files)
  cat <project> <path>                    print a document
  append <project> <path> [text|-]        append text (- / omit reads stdin)
  insert <project> <path> <line> <col> [text|-]
  replace <project> <path> <old> <new> [--count N]
  set <project> <path>                    replace whole document with stdin
  search <project> <path> <query>         find text
  compile <project> [--draft] [--stop-on-first-error] [--log] [--warnings]
  mcp                                     run the MCP server over stdio

project is an id or name. line/column are 0-based.`;

async function run(argv: string[]): Promise<number> {
  const command = argv[0];
  const { positionals, flags } = parseArgs(argv.slice(1));

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === "mcp") {
    const { run: runMcp } = await import("./mcpServer.js");
    await runMcp();
    return 0;
  }

  if (command === "login") {
    const config = Config.fromEnv();
    const client = new OverleafClient(config);
    const cookies = await client.login();
    console.log(`Signed in. Session cached at ${config.sessionPath}`);
    console.log(`Cookies: ${Object.keys(cookies).join(", ")}`);
    return 0;
  }

  if (command === "doctor") {
    const config = Config.fromEnv();
    const client = new OverleafClient(config);
    console.log(`Base URL: ${config.baseUrl}`);
    console.log(`Session:  ${config.sessionPath}`);
    if (!(await client.isLoggedIn())) {
      console.log("Not signed in. Run `claudeleaf login`.");
      return 1;
    }
    console.log("Signed in: yes");
    const projects = await client.listProjects();
    console.log(`Projects:  ${projects.length}`);
    for (const p of projects) console.log(`  ${p.id}  ${p.name}  (${p.accessLevel})`);
    console.log("All good.");
    return 0;
  }

  if (command === "projects") {
    const client = new OverleafClient(Config.fromEnv());
    for (const p of await client.listProjects()) {
      const marks = [p.archived ? "A" : "", p.trashed ? "T" : ""].join("");
      console.log(`${p.id}  ${p.name}  [${p.accessLevel}${marks ? " " + marks : ""}]`);
    }
    return 0;
  }

  // Commands below operate on a project.
  const client = new OverleafClient(Config.fromEnv());
  const project = positionals[0];
  if (!project) {
    console.error(`error: '${command}' needs a project (id or name)`);
    return 1;
  }
  try {
    switch (command) {
      case "info": {
        const info = await client.projectInfo(project);
        for (const [k, v] of Object.entries(info)) console.log(`${k.padEnd(20)}: ${v}`);
        return 0;
      }
      case "ls": {
        for (const e of await client.listDocuments(project, Boolean(flags.all))) {
          console.log(`${e.type.padEnd(5)} ${e.path}`);
        }
        return 0;
      }
      case "cat": {
        process.stdout.write(await client.readDocument(project, positionals[1]));
        return 0;
      }
      case "append": {
        const text = await textArg(positionals[2]);
        await client.append(project, positionals[1], text);
        console.log(`Appended ${text.length} chars to ${positionals[1]}`);
        return 0;
      }
      case "insert": {
        const line = Number(positionals[2]);
        const col = Number(positionals[3]);
        const text = await textArg(positionals[4]);
        await client.insert(project, positionals[1], line, col, text);
        console.log(`Inserted at ${line}:${col} in ${positionals[1]}`);
        return 0;
      }
      case "replace": {
        const n = await client.replaceText(
          project,
          positionals[1],
          positionals[2],
          positionals[3],
          flags.count ? Number(flags.count) : 0,
        );
        console.log(`Replaced ${n} occurrence(s) in ${positionals[1]}`);
        return 0;
      }
      case "set": {
        const text = await readStdin();
        await client.setText(project, positionals[1], text);
        console.log(`Set ${positionals[1]} (${text.length} chars)`);
        return 0;
      }
      case "search": {
        for (const hit of await client.search(project, positionals[1], positionals[2])) {
          console.log(`line ${hit.line}, col ${hit.column} (offset ${hit.offset})`);
        }
        return 0;
      }
      case "compile": {
        const result = await client.compile(project, {
          draft: Boolean(flags.draft),
          stopOnFirstError: Boolean(flags["stop-on-first-error"]),
        });
        const fmt = (e: { file?: string; line?: number; message: string }) =>
          `${e.file ?? "?"}:${e.line ?? "?"}: ${e.message}`;
        console.log(`Status: ${result.status}`);
        console.log(`Errors: ${result.errors.length}  Warnings: ${result.warnings.length}`);
        for (const e of result.errors) console.log(`  error  ${fmt(e)}`);
        if (flags.warnings) for (const w of result.warnings) console.log(`  warn   ${fmt(w)}`);
        if (flags.log) {
          console.log("\n--- output.log ---");
          process.stdout.write(result.log);
        }
        // Exit non-zero when the compile failed or produced errors (useful in scripts).
        return result.success && result.errors.length === 0 ? 0 : 2;
      }
      default:
        console.error(`error: unknown command '${command}'`);
        console.error(USAGE);
        return 1;
    }
  } finally {
    client.close();
  }
}

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ClaudeleafError) console.error(`error: ${err.message}`);
    else console.error(err);
    process.exit(1);
  });
