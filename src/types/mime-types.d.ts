declare module 'mime-types' {
  interface MimeTypesModule {
    lookup(path: string): string | false;
  }

  const mime: MimeTypesModule;
  export default mime;
}
