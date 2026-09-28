// Test-only dependency resolver for an existing DSH installation.
// It never installs packages or changes the target installation.
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
if (!process.env.DSH_TEST_HOST_MANIFEST) throw new Error('Set DSH_TEST_HOST_MANIFEST to the installed dsh-base/package.json')
const hostRequire = createRequire(process.env.DSH_TEST_HOST_MANIFEST)
const hostURL = pathToFileURL(process.env.DSH_TEST_HOST_MANIFEST).href
const adapterURL = pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) }
    catch (error) {
      const hostDependency = specifier.startsWith('@deepseek-ai/dsh-') || specifier === '@deepseek-ai/schemastery' || specifier.startsWith('@earendil-works/pi-ai/') || specifier === '@earendil-works/pi-ai'
      if (!hostDependency || error.code !== 'ERR_MODULE_NOT_FOUND') throw error
      // Preserve ESM import conditions, including pi-ai's import-only exports.
      try { return nextResolve(specifier, { ...context, parentURL: hostURL }) }
      catch { return nextResolve(specifier, { ...context, parentURL: adapterURL }) }
    }
  },
})
