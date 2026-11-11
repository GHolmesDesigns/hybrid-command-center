/** The supplied Command AI mark, sized by its surrounding control. */
export function CommandAiGlyph({ inverseSurface = false }: { inverseSurface?: boolean }) {
  return (
    <span
      className={`command-ai-glyph${inverseSurface ? ' inverse-surface' : ''}`}
      aria-hidden="true"
    >
      <img className="command-ai-glyph-primary" src="/command-ai/logo-icon.svg" alt="" />
      <img className="command-ai-glyph-white" src="/command-ai/logo-icon-white.svg" alt="" />
    </span>
  );
}
