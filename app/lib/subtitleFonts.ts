// 100 Google Fonts families curated for subtitle burn-in. Grouped by
// category so the picker can render section headers. Each `name` is what
// gets stored in SubtitleSettings.fontFamily AND passed verbatim into the
// ASS style block's Fontname field — so if you change a label here, the
// existing saved projects still resolve (the name IS the identifier).
//
// On the web these load via the Google Fonts CSS2 API (see buildGoogleFontsUrl).
// On the render side, ffmpeg's ASS renderer looks the font up in the system
// font directory; if it isn't installed there it falls back. Future work:
// auto-download the selected font's TTF and pass fontsdir= to the subtitles
// filter so renders are pixel-identical to the preview.

export type FontCategory =
  | 'sans'
  | 'modern'
  | 'condensed'
  | 'serif'
  | 'display'
  | 'slab'
  | 'mono'
  | 'script';

export type SubtitleFont = {
  name: string; // exact name as it appears in settings + ASS Fontname field
  category: FontCategory;
};

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: 'Sans-serif',
  modern: 'Modern · geometric',
  condensed: 'Condensed · narrow',
  serif: 'Serif',
  display: 'Display · hero',
  slab: 'Slab-serif',
  mono: 'Monospace',
  script: 'Script · handwriting',
};

export const SUBTITLE_FONTS: SubtitleFont[] = [
  // --- Sans-serif workhorses (20) ---
  { name: 'Inter',              category: 'sans' },
  { name: 'Roboto',             category: 'sans' },
  { name: 'Open Sans',          category: 'sans' },
  { name: 'Lato',               category: 'sans' },
  { name: 'Montserrat',         category: 'sans' },
  { name: 'Poppins',            category: 'sans' },
  { name: 'Source Sans 3',      category: 'sans' },
  { name: 'Nunito',             category: 'sans' },
  { name: 'Nunito Sans',        category: 'sans' },
  { name: 'Raleway',            category: 'sans' },
  { name: 'Rubik',              category: 'sans' },
  { name: 'Work Sans',          category: 'sans' },
  { name: 'Fira Sans',          category: 'sans' },
  { name: 'Manrope',            category: 'sans' },
  { name: 'Ubuntu',             category: 'sans' },
  { name: 'Noto Sans',          category: 'sans' },
  { name: 'PT Sans',            category: 'sans' },
  { name: 'Mulish',             category: 'sans' },
  { name: 'Questrial',          category: 'sans' },
  { name: 'Jost',               category: 'sans' },

  // --- Modern / geometric (20) ---
  { name: 'Space Grotesk',      category: 'modern' },
  { name: 'DM Sans',            category: 'modern' },
  { name: 'Archivo',            category: 'modern' },
  { name: 'Karla',              category: 'modern' },
  { name: 'Plus Jakarta Sans',  category: 'modern' },
  { name: 'Syne',               category: 'modern' },
  { name: 'Outfit',             category: 'modern' },
  { name: 'Red Hat Display',    category: 'modern' },
  { name: 'Lexend',             category: 'modern' },
  { name: 'Sora',               category: 'modern' },
  { name: 'Urbanist',           category: 'modern' },
  { name: 'Albert Sans',        category: 'modern' },
  { name: 'Figtree',            category: 'modern' },
  { name: 'Onest',              category: 'modern' },
  { name: 'Hanken Grotesk',     category: 'modern' },
  { name: 'Instrument Sans',    category: 'modern' },
  { name: 'Chivo',              category: 'modern' },
  { name: 'Barlow',             category: 'modern' },
  { name: 'Asap',               category: 'modern' },
  { name: 'Kumbh Sans',         category: 'modern' },

  // --- Condensed / narrow (10) ---
  { name: 'Oswald',             category: 'condensed' },
  { name: 'Bebas Neue',         category: 'condensed' },
  { name: 'Anton',              category: 'condensed' },
  { name: 'Archivo Narrow',     category: 'condensed' },
  { name: 'Archivo Black',      category: 'condensed' },
  { name: 'Barlow Condensed',   category: 'condensed' },
  { name: 'Fjalla One',         category: 'condensed' },
  { name: 'Staatliches',        category: 'condensed' },
  { name: 'Passion One',        category: 'condensed' },
  { name: 'Teko',               category: 'condensed' },

  // --- Serif (15) ---
  { name: 'Playfair Display',   category: 'serif' },
  { name: 'Merriweather',       category: 'serif' },
  { name: 'Lora',               category: 'serif' },
  { name: 'Source Serif 4',     category: 'serif' },
  { name: 'Cormorant Garamond', category: 'serif' },
  { name: 'EB Garamond',        category: 'serif' },
  { name: 'Crimson Text',       category: 'serif' },
  { name: 'Libre Baskerville',  category: 'serif' },
  { name: 'DM Serif Display',   category: 'serif' },
  { name: 'DM Serif Text',      category: 'serif' },
  { name: 'Spectral',           category: 'serif' },
  { name: 'Noto Serif',         category: 'serif' },
  { name: 'Cardo',              category: 'serif' },
  { name: 'Alegreya',           category: 'serif' },
  { name: 'Bitter',             category: 'serif' },

  // --- Display / hero (10) ---
  { name: 'Bungee',             category: 'display' },
  { name: 'Righteous',          category: 'display' },
  { name: 'Russo One',          category: 'display' },
  { name: 'Audiowide',          category: 'display' },
  { name: 'Orbitron',           category: 'display' },
  { name: 'Exo 2',              category: 'display' },
  { name: 'Monoton',            category: 'display' },
  { name: 'Alfa Slab One',      category: 'display' },
  { name: 'Abril Fatface',      category: 'display' },
  { name: 'Ultra',              category: 'display' },

  // --- Slab-serif (5) ---
  { name: 'Roboto Slab',        category: 'slab' },
  { name: 'Zilla Slab',         category: 'slab' },
  { name: 'Arvo',               category: 'slab' },
  { name: 'Rokkitt',            category: 'slab' },
  { name: 'Josefin Slab',       category: 'slab' },

  // --- Monospace (10) ---
  { name: 'Space Mono',         category: 'mono' },
  { name: 'JetBrains Mono',     category: 'mono' },
  { name: 'IBM Plex Mono',      category: 'mono' },
  { name: 'Fira Code',          category: 'mono' },
  { name: 'Roboto Mono',        category: 'mono' },
  { name: 'Source Code Pro',    category: 'mono' },
  { name: 'Inconsolata',        category: 'mono' },
  { name: 'Ubuntu Mono',        category: 'mono' },
  { name: 'Cousine',            category: 'mono' },
  { name: 'VT323',              category: 'mono' },

  // --- Script / handwriting / cinematic (10) ---
  { name: 'Cinzel',             category: 'script' },
  { name: 'Amatic SC',          category: 'script' },
  { name: 'Permanent Marker',   category: 'script' },
  { name: 'Caveat',             category: 'script' },
  { name: 'Dancing Script',     category: 'script' },
  { name: 'Shadows Into Light', category: 'script' },
  { name: 'Great Vibes',        category: 'script' },
  { name: 'Pacifico',           category: 'script' },
  { name: 'Lobster',            category: 'script' },
  { name: 'Yanone Kaffeesatz',  category: 'script' },
];

export const DEFAULT_SUBTITLE_FONT = 'Inter';

// Build a single Google Fonts CSS2 URL loading all 100 families at weights
// 400 and 700. ~3 KB of CSS; individual font files only download when used.
export function buildGoogleFontsUrl(weights: string[] = ['400', '700']): string {
  const params = SUBTITLE_FONTS.map((f) => {
    const g = f.name.replace(/ /g, '+');
    return `family=${g}:wght@${weights.join(';')}`;
  }).join('&');
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}

// Resolve a stored font name to a safe CSS font-family stack. If the stored
// name isn't in our catalog (e.g. old project saved before this feature),
// fall back to system-ui so nothing looks broken.
export function fontFamilyStack(name: string | undefined): string {
  const hit = SUBTITLE_FONTS.find((f) => f.name === name);
  if (!hit) {
    return 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  }
  const systemFallback =
    hit.category === 'mono'
      ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
      : hit.category === 'serif' || hit.category === 'slab'
        ? 'Georgia, "Times New Roman", serif'
        : hit.category === 'script'
          ? 'cursive'
          : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  return `"${hit.name}", ${systemFallback}`;
}
