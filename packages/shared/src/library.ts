export type LibraryKind = 'problems' | 'contests';
export interface LibraryLocation { kind: LibraryKind; root?: string; folder?: string; recursive?: boolean }
export interface LibraryDirectory { kind: LibraryKind; root: string; folder: string; folders: { name: string; path: string }[] }
export interface CreateLibraryFolderRequest extends LibraryLocation { name: string }
