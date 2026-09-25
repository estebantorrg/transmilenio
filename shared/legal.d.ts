/** One section of a legal page: a numbered heading over authored HTML. */
export interface LegalSection {
  titulo: string;
  /** Trusted, authored markup (never user or upstream data). */
  html: string;
}

export interface LegalDoc {
  /** Canonical pathname, with the trailing slash the static mount serves. */
  path: string;
  titulo: string;
  /** Short name for the breadcrumb and links. */
  breadcrumb: string;
  /** Meta description (kept under ~158 characters). */
  descripcion: string;
  /** Effective date as it is printed ("26 de septiembre de 2026"). */
  vigencia: string;
  /** The notice at the top of the page (the aviso de privacidad, for the policy). */
  resumen: string;
  secciones: LegalSection[];
}

export declare const RESPONSABLE: { nombre: string; correo: string; ciudad: string };
export declare const PRIVACIDAD: LegalDoc;
export declare const LEGAL_DOCS: LegalDoc[];

/** The legal page at `pathname` (trailing slash and case ignored), or null. */
export declare function legalDocForPath(pathname: string): LegalDoc | null;

/** The document body without page chrome, identical in the prerender and the app. */
export declare function legalDocHtml(doc: LegalDoc): string;

/** The legal pages' stylesheet (inlined by the prerender). */
export declare const LEGAL_CSS: string;

/** Adds `LEGAL_CSS` to the document once. */
export declare function ensureLegalStyle(): void;
