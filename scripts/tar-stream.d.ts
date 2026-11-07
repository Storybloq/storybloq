// The one entry point of tar-stream 2.2.0 the reader uses; @types/tar-stream is not in the tree.
declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";
  export interface Headers { name: string; size?: number; type: string | null; linkname?: string | null; mode?: number }
  export interface Extract extends Writable {
    on(event: "entry", listener: (header: Headers, stream: Readable, next: (err?: Error) => void) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  const tarStream: { extract(): Extract };
  export default tarStream;
}
