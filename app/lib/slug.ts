// Shared slug helper used by both `/api/projects` and the new Series +
// Episode routes. Lowercases, collapses non-alphanumeric runs to a single
// underscore, strips leading/trailing underscores, and caps at 60 chars
// so Supabase path segments stay sane. Duplicated in app/api/projects/
// route.ts for now — importing it there is a follow-up cleanup.
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}
