declare module '*?url' {
  const url: string;
  export default url;
}


interface ImportMetaEnv {
  readonly VITE_SERVER_TOKEN?: string;
  readonly VITE_SERVER_TENANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
