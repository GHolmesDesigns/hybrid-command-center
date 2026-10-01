/** The shared Command AI mark, sized by its surrounding control. */
export function CommandAiGlyph() {
  return (
    <svg
      className="command-ai-glyph"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 0 1-8 8H8l-4 2v-6a8 8 0 1 1 16-4Z" />
      <path d="m12 7 .9 2.1L15 10l-2.1.9L12 13l-.9-2.1L9 10l2.1-.9L12 7Z" />
    </svg>
  );
}
