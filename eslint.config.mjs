import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Provider clients are constructed only inside their gateway, where every request goes
  // through the live-call guard (src/lib/providers/live-call-guard.ts). A client built
  // anywhere else would bypass it; the SDKs' error classes and types stay importable.
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "worker/**/*.ts"],
    ignores: ["src/lib/claude.ts", "src/lib/images/gateway.ts", "src/lib/voiceover/gateway.ts", "src/lib/music/gateway.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@anthropic-ai/sdk", importNames: ["default", "Anthropic"], allowTypeImports: true,
            message: "Construct Anthropic clients only in src/lib/claude.ts (behind the live-call guard)." },
          { name: "openai", importNames: ["default", "OpenAI", "AzureOpenAI"], allowTypeImports: true,
            message: "Construct OpenAI clients only in src/lib/images/gateway.ts (behind the live-call guard)." },
        ],
      }],
      "no-restricted-syntax": ["error", {
        selector: "Literal[value=/api\\.(anthropic|openai|elevenlabs)\\.(com|io)|fal\\.(run|ai)/], TemplateElement[value.raw=/api\\.(anthropic|openai|elevenlabs)\\.(com|io)|fal\\.(run|ai)/]",
        message: "Provider hosts are called only from their gateway, through guardedFetch.",
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
