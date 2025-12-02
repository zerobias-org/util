import { Resolver } from "@stoplight/json-ref-resolver";

// Simple $ref resolver to skip over remote references.
// As it turns out their default resolver doesn't seem to play well with Circular References.
// Reference for js capabilities: https://meta.stoplight.io/docs/spectral/ZG9jOjI1MTg3-spectral-in-java-script
export default new Resolver({
  dereferenceInline: true,
  dereferenceRemote: false
});
