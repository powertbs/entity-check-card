import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

const dev = process.env.ROLLUP_WATCH === "true";

export default {
  input: "src/entity-check-card.ts",
  output: {
    file: "dist/entity-check-card.js",
    format: "es",
    sourcemap: dev,
  },
  plugins: [
    resolve(),
    typescript({ tsconfig: "./tsconfig.json", include: ["src/**/*.ts"] }),
    !dev && terser({ format: { comments: false } }),
  ],
};
