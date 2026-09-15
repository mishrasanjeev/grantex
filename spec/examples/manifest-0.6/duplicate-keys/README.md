Manifest files with a key repeated inside one object. JSON Schema validators see only
the parsed object, so these are checked by the SDK loaders, which must reject each file
with `ToolManifest: duplicate key "<key>" in manifest file`.
