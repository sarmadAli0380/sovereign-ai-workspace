/**
 * Terminal implementation of pi-ai's `AuthInteraction`.
 *
 * Not in any ADR — needed because pi-ai leaves login/logout orchestration
 * to the app ("Login/logout orchestration is app-owned"). It renders the
 * provider's own OAuth prompts and events to the terminal and reads the
 * user's answers back from stdin.
 *
 * The harness never handles the credential itself: the provider's flow
 * returns it, and pi-ai persists it through the CredentialStore.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export function terminalAuthInteraction(): AuthInteraction {
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "secret") {
        // Readline echoes typed characters by writing them to its configured
        // output. Give it a muted sink and render only our own prompt/newline,
        // so long-lived API keys do not appear in terminal scrollback,
        // recordings, or shared-session logs.
        const muted = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        const rl = createInterface({
          input: stdin,
          output: muted,
          terminal: Boolean(stdin.isTTY),
        });
        stdout.write(`\n${prompt.message}\n> `);
        try {
          const answer = (await rl.question("")).trim();
          stdout.write("\n");
          return answer;
        } finally {
          rl.close();
        }
      }

      const rl = createInterface({ input: stdin, output: stdout });
      try {
        if (prompt.type === "select") {
          console.log(`\n${prompt.message}`);
          prompt.options.forEach((option, i) => {
            const description = option.description ? ` — ${option.description}` : "";
            console.log(`  ${i + 1}) ${option.label}${description}`);
          });

          while (true) {
            const answer = (await rl.question("Choose a number: ")).trim();
            const index = Number(answer) - 1;
            const chosen = prompt.options[index];
            if (chosen) return chosen.id;
            console.log("Not a valid choice — try again.");
          }
        }

        // "text" and "manual_code" read one visible line. Secret input is
        // handled above without echo.
        return (await rl.question(`\n${prompt.message}\n> `)).trim();
      } finally {
        rl.close();
      }
    },

    notify(event: AuthEvent): void {
      switch (event.type) {
        case "info":
          console.log(`\n${event.message}`);
          for (const link of event.links ?? []) {
            console.log(`  ${link.label ? `${link.label}: ` : ""}${link.url}`);
          }
          break;

        case "auth_url":
          console.log("\nOpen this URL in your browser to authorize:");
          console.log(`\n  ${event.url}\n`);
          if (event.instructions) console.log(event.instructions);
          break;

        case "device_code":
          console.log(`\nGo to: ${event.verificationUri}`);
          console.log(`Enter code: ${event.userCode}`);
          if (event.expiresInSeconds) {
            console.log(`(expires in ${Math.round(event.expiresInSeconds / 60)} min)`);
          }
          break;

        case "progress":
          console.log(`… ${event.message}`);
          break;
      }
    },
  };
}
