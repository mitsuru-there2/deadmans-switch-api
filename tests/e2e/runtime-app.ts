import { createApp } from "../../src/app";
import { storeVerifier, transport } from "./providers";
export const app = createApp({ storeVerifier, transport });
