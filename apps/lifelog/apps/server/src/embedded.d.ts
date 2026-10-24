// A file `bun build --compile` embeds, imported `with { type: "file" }`: its path.
declare module "*.onnx" {
  const path: string;
  export default path;
}
