# Change Log

All notable changes to the "UnifiedXJPath (Dansharp) Viewer" extension will be documented in this file.

## [1.0.0] - 2025-11-07

### Added
- Initial release of UnifiedXJPath (Dansharp) Viewer
- Split viewer for XML and JSON files with synchronized tree and inspector
- XPath query support for XML documents
- JSONPath query support for JSON documents
- Interactive tree view with expand/collapse functionality
- Property inspector showing detailed node information
- Path copying functionality for selected nodes
- Document formatting support
- Namespace management for XML XPath queries
- Syntax highlighting for query results
- Real-time query evaluation
- Error handling and validation for queries
- Custom extension icon with XML/JSON visual representation

### Features
- **XML Support**: Full XPath 1.0 query evaluation with namespace support
- **JSON Support**: JSONPath query evaluation with comprehensive syntax support
- **Tree View**: Interactive hierarchical tree display with navigation
- **Inspector Panel**: Detailed property view for selected nodes
- **Path Generation**: Automatic XPath/JSONPath generation for selected elements
- **Configuration**: Customizable output limits and path formatting options

### Configuration
- `unifiedQuery.namespaces`: Namespace prefix to URI mappings for XPath queries
- `unifiedQuery.outputLimit`: Maximum number of characters to display in result previews (default: 200)
- `unifiedQuery.compactPaths`: Omit redundant [1] indexes for unique children in generated paths (default: false)

## [0.5.0] - 2025-11-07

### Development
- Beta release for testing and feedback
- Core functionality implementation
- Initial UI design and layout
