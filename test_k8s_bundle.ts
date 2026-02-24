import { bundleExtension } from "./src/domain/models/bundle.ts";

try {
  const result = await bundleExtension("/tmp/poop/extensions/models/k8s_pods.ts");
  console.log("SUCCESS: Bundled k8s_pods.ts");
  console.log("Bundle size:", result.length, "bytes");
} catch (error) {
  console.error("ERROR:", error.message);
  if (error.stack) {
    console.error("Stack:", error.stack.split('\n').slice(0, 10).join('\n'));
  }
}
