// `import pem from "./x.pem" with { type: "text" }` — Bun inlines the file as a string,
// including into the `--compile` binary.
declare module "*.pem" {
  const content: string;
  export default content;
}
