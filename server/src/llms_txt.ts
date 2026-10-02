/**
 * `/llms.txt` — the site described for a language model, in the llmstxt.org
 * shape: a title, a one-paragraph summary, what the pages are and how far to
 * trust them, then the pages themselves as link lists (spec §5.5.4).
 *
 * Generated at build time with the sitemaps, from the same lists, so it can
 * never name a page that does not exist or miss one that does. Written in
 * Spanish, the site's own language, with the codes and station names exactly
 * as the pages print them — those are what a rider will ask about.
 */

export interface LlmsRoute {
  url: string;
  codigo: string;
  origen: string;
  destino: string;
  /** The catalog's `tipoServicio` (`TRONCAL`, `ALIMENTADOR`, …). */
  tipo: string;
}

export interface LlmsStation {
  url: string;
  nombre: string;
  /** The troncal it sits on ("Autonorte"), when known. */
  corredor?: string;
}

export interface LlmsInput {
  origin: string;
  routes: LlmsRoute[];
  stations: LlmsStation[];
  /** Indexable pages beyond routes and stations (`/terminos/`), with a title. */
  extra: Array<{ url: string; titulo: string }>;
  repo: string;
}

/** Markdown link text cannot carry a bare bracket. */
const md = (s: string): string => s.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();

const byCode = (a: LlmsRoute, b: LlmsRoute): number =>
  a.codigo.localeCompare(b.codigo, 'es', { numeric: true, sensitivity: 'base' });

export function renderLlmsTxt(input: LlmsInput): string {
  const { origin } = input;
  const abs = (url: string): string => `${origin}${url}`;
  const route = (r: LlmsRoute): string => {
    const tramo = [r.origen, r.destino].filter(Boolean).map(md).join(' ↔ ');
    return `- [Ruta ${md(r.codigo)}](${abs(r.url)})${tramo ? `: ${tramo}` : ''}`;
  };

  // The catalog's own service types, grouped the way a rider names them.
  const GRUPOS: Array<[titulo: string, tipos: string[]]> = [
    ['Rutas troncales', ['TRONCAL']],
    ['Alimentadores', ['ALIMENTADOR', 'ALIMENTADOR_V']],
    ['Padrones y rutas urbanas', ['PADRON', 'URBANO']],
  ];
  const conocidos = new Set(GRUPOS.flatMap(([, tipos]) => tipos));
  const grupos = [
    ...GRUPOS.map(([titulo, tipos]) => [titulo, input.routes.filter((r) => tipos.includes(r.tipo))] as const),
    ['Otras rutas de TransMilenio', input.routes.filter((r) => !conocidos.has(r.tipo))] as const,
  ].filter(([, rs]) => rs.length > 0);
  const stations = [...input.stations].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));

  return [
    '# TransMilenio Explorer',
    '',
    '> Aplicación web independiente y no oficial sobre el sistema TransMilenio de Bogotá: cada ruta troncal, alimentadora y padrón con sus paradas y horarios, cada estación con un plano de en qué vagón se toma cada servicio, llegadas en vivo y un planeador de viajes. No está afiliada a TRANSMILENIO S.A.',
    '',
    'Qué contiene cada página:',
    '',
    '- **Ruta** (`/ruta/<código>/`): el recorrido de un servicio de TransMilenio — troncal (B11, F19, H15…), alimentador (1-2, 8-4…) o padrón — sus paradas en orden, el vagón en el que se aborda en cada estación cuando el plano oficial lo dice, las líneas con las que se puede transbordar, y sus horarios por tipo de día.',
    '- **Estación** (`/estacion/<nombre>-<código>/`): la troncal en la que está, sus vagones y los servicios que paran en cada lado de cada vagón (dibujados a partir del *plano de ubicación* oficial), accesos, taquillas y salidas cuando el plano los señala, y los alimentadores y servicios zonales que la atienden.',
    '- Ricaurte y Avenida Jiménez son cada una dos estaciones en troncales distintas; cada mitad tiene su propia página.',
    '',
    'Sobre los datos: provienen del catálogo oficial de TRANSMILENIO S.A. y de sus planos de ubicación, y se actualizan cuando el operador los cambia. Los horarios y la asignación de vagones pueden cambiar sin aviso; para algo crítico, confirma con la señalización de la estación o con los canales oficiales. `/api/` es el backend de la aplicación, no contenido para leer.',
    '',
    '## Páginas principales',
    '',
    `- [Mapa, buscador y planeador](${abs('/')}): el mapa interactivo de rutas, estaciones y paraderos de TransMilenio y SITP.`,
    ...input.extra.map((p) => `- [${md(p.titulo)}](${abs(p.url)})`),
    '',
    `## Estaciones (${stations.length})`,
    '',
    ...stations.map((s) => `- [${md(s.nombre)}](${abs(s.url)})${s.corredor ? `: Troncal ${md(s.corredor)}` : ''}`),
    '',
    ...grupos.flatMap(([titulo, rs]) => [`## ${titulo} (${rs.length})`, '', ...[...rs].sort(byCode).map(route), '']),
    '## Optional',
    '',
    `- [Sitemap](${abs('/sitemap.xml')}): todas las páginas, con la fecha en que cambió su contenido.`,
    `- [Código fuente](${input.repo}): el proyecto en GitHub.`,
    '',
  ].join('\n');
}
