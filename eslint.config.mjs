import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local git worktrees (see .git/info/exclude): other branches, not this tree.
    ".claude/worktrees/**",
  ]),
  {
    // Type-aware rules. These catch the class of bug a plain lint can't: a fetch whose rejection nobody
    // handles (a skeleton that never resolves, a busy flag stuck on), an async callback handed to
    // setInterval or forEach, a switch over a union that silently ignores a new member.
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // React event handlers may be async: the attribute check is off, the argument check stays on.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports", disallowTypeAnnotations: false }],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // vi.fn().mockImplementation(async ...) is the normal way to fake fetch; the void-return check misreads it.
    files: ["**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-misused-promises": "off" },
  },
  {
    // shadcn's own hook (installed by `shadcn add sidebar`): it sets state in an effect on purpose to read the viewport after mount. Re-adding the item overwrites the file, so the exception lives here.
    files: ["hooks/use-mobile.ts"],
    rules: { "react-hooks/set-state-in-effect": "off" },
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ignores: ["**/components/ui/icons/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["lucide-react"], message: "Import the per-icon module from @/components/ui/icons/ instead." },
            { group: ["@material-symbols-svg/**"], message: "Only the modules in components/ui/icons/ may import the vendor package." },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ignores: ["**/components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["Literal", "TemplateElement"].flatMap((node) => {
          const value = node === "Literal" ? "value" : "value.raw";
          return [
            { selector: `${node}[${value}=/\\btext-\\[\\d/]`, message: "Arbitrary text size: use a type-scale class (text-body-s, text-title-xs...)." },
            { selector: `${node}[${value}=/-\\[#[\\da-fA-F]{3,8}\\]/]`, message: "Raw hex colour: use a semantic token (bg-primary, text-muted-foreground...)." },
          ];
        }),
      ],
    },
  },
]);

export default eslintConfig;
