# Task Extender Plugin - Project Structure

A brief overview of the project structure, outlining the core purpose of each file in the codebase.

## Core Files

**main.ts**
The main entry point for the plugin. Handles initialization, settings, and view registration.

**TaskParser.ts**
Parses task text to extract metadata such as dates, time estimates, and completion status.

## Timeline Directory

**TimelineView.ts**
The main view component that renders the timeline interface and coordinates other managers.

**TaskManager.ts**
Manages all task-related operations including creation, tracking, and updating.

**TimeBlockManager.ts**
Handles time blocks and their visualization in the timeline.

**TaskDragManager.ts**
Controls drag and drop operations for tasks within the timeline.

**TimelineInterfaces.ts**
Contains interface definitions used across timeline components.

**TimeEstimateModal.ts**
Modal dialog for managing time estimates for tasks.

**TimelineUtils.ts**
Utility functions for timeline operations such as time formatting and zooming.

**TimelineComponents.ts**
Reusable UI components used in the timeline interface.

## Models Directory

**TimeBlock.ts**
Defines the data structure for time blocks.

**ScheduledTask.ts**
Defines the data structure for scheduled tasks.

## Styling

**styles.css**
Provides styling for all plugin UI elements.

## Where to Add New Functionality

- **Task-related features**: TaskManager.ts or TaskParser.ts
- **Time block features**: TimeBlockManager.ts
- **UI components**: TimelineComponents.ts
- **Timeline interactions**: TimelineView.ts or TaskDragManager.ts
- **Data structures**: Models directory
- **Plugin settings**: main.ts
- **Styling**: styles.css 