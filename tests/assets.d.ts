declare module "*.cer" {
  const certificate: ArrayBuffer;
  export default certificate;
}

declare module "*.cer?inline" {
  const value: string;
  export default value;
}
