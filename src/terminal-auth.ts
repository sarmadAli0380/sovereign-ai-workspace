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
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export function terminalAuthInteraction(): AuthInteraction {
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
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

        // "text", "secret" and "manual_code" all read one line. Terminal
        // echo is left on even for "secret": the values here are pasted
        // one-time codes, and silently swallowing keystrokes reads as a
        // hang. Nothing long-lived is typed at this prompt.
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
