/**
 * @cubone/react-file-manager 1.35.0 的 package.json 没有 `types` 字段、包里也不带 .d.ts，
 * tsc 找不到声明会直接报错。这里按它的 README（public API 表）补一份最小声明，
 * 只覆盖我们用到的 prop；用到别的 prop 时按 README 继续往下加即可。
 */
declare module '@cubone/react-file-manager' {
  export interface FileManagerFile {
    name: string;
    isDirectory: boolean;
    path: string;
    updatedAt?: string;
    size?: number;
  }

  export interface FileManagerPermissions {
    create?: boolean;
    upload?: boolean;
    move?: boolean;
    copy?: boolean;
    rename?: boolean;
    download?: boolean;
    delete?: boolean;
  }

  export interface FileManagerProps {
    files: FileManagerFile[];
    /** 只在组件挂载时读取一次；换路径要同时换 key（见 FolderBrowser.tsx 的说明）。 */
    initialPath?: string;
    onFolderChange?: (path: string) => void;
    onFileOpen?: (file: FileManagerFile) => void;
    onSelectionChange?: (files: FileManagerFile[]) => void;
    onLayoutChange?: (layout: 'grid' | 'list') => void;
    onRefresh?: () => void;
    onError?: (error: { type: string; message: string }, file?: FileManagerFile) => void;
    permissions?: FileManagerPermissions;
    layout?: 'grid' | 'list';
    height?: string;
    width?: string;
    primaryColor?: string;
    fontFamily?: string;
    language?: string;
    collapsibleNav?: boolean;
    defaultNavExpanded?: boolean;
    enableFilePreview?: boolean;
    isLoading?: boolean;
    className?: string;
  }

  export const FileManager: import('react').ComponentType<FileManagerProps>;
}
