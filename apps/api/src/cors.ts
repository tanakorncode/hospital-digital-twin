// Allowed browser origins: WEB_ORIGIN (comma-separated) plus any localhost port for local development.
const allowed = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((o) => o.trim());
export function allowOrigin(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
  cb(null, !origin || allowed.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin));
}
