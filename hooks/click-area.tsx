import type { ClientModule, JsonValue } from 'claude-code'

/**
 * An empty region laid over the band: a click anywhere on it asks the hooks module
 * to open or close the breakdown. What shows through is drawn by the band itself.
 */
const ClickArea: ClientModule<JsonValue> = (_props, surface) => {
  surface.onPointer(e => {
    if (e.type === 'down' && e.button !== 'right' && e.button !== 'middle') surface.post({ type: 'toggle' })
  })
  const { Box } = surface.elements
  return <Box flexGrow={1} />
}

export default ClickArea
