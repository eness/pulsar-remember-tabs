# Changelog

## 1.1.0 - Untitled tab restoration

- Added support for saving and restoring non-empty untitled editor tabs with their text.
- Added untitled editor specs for persistence and restore behavior.
- Updated documentation to describe untitled tab restoration and empty untitled tab handling.

## 1.0.0 - Initial release

- Added automatic restoration of open file tabs after Pulsar restarts.
- Added support for restoring tabs even when no project folder is open.
- Preserved the active tab when reopening saved tabs.
- Skipped duplicate, deleted, moved, or inaccessible file paths during restore.
- Added package specs for saving and restoring file tab paths.
