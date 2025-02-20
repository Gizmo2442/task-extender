import { View, WorkspaceLeaf, moment, TFile, MarkdownRenderer, Modal, Setting, App } from 'obsidian';
import type TaskPlannerPlugin from '../main';
import { TaskParser, type TaskMetadata } from './taskParser';
import type { ScheduledTask } from './models/ScheduledTask';
import type { TimeBlock } from './models/TimeBlock';
import { debounce } from 'obsidian';

interface TaskIdentity {
    identifier: string;  // Either plugin ID or content hash
    originalContent: string;
    metadata: TaskMetadata;
    filePath: string;  // Add file path tracking
}

export class TimelineView extends View {
    private plugin: TaskPlannerPlugin;
    private timelineEl: HTMLElement;
    private timeSlots: Map<number, HTMLElement> = new Map();
    private scheduledTasks: Map<string, ScheduledTask> = new Map();
    private currentDayFile: TFile | null = null;
    private taskElements: Map<string, HTMLElement> = new Map();
    private timeBlocks: Map<string, TimeBlock> = new Map();
    private isCreatingTimeBlock: boolean = false;
    private timeBlockStart: number | null = null;
    private taskCache: Map<string, TaskIdentity> = new Map();
    private fileCache: Map<string, string> = new Map();
    private refreshDebounceTimer: number | null = null;
    private debouncedRefresh: () => void;
    private hourHeight: number = 80; // Default height doubled from 40
    private minHourHeight: number = 40;
    private maxHourHeight: number = 200;
    private debugEnabled: boolean = true;
    private modifiedFiles: Set<string> = new Set();

    constructor(leaf: WorkspaceLeaf, plugin: TaskPlannerPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.debouncedRefresh = debounce(this.refreshView.bind(this), 1000, true);
    }

    getViewType(): string {
        return 'timeline-view';
    }

    getDisplayText(): string {
        return 'Task Timeline';
    }

    async onOpen() {
        const { containerEl } = this;
        containerEl.empty();
        
        // Create main container
        const mainContainer = containerEl.createEl('div', { cls: 'timeline-main-container' });
        
        // Create header
        const headerEl = mainContainer.createEl('div', { cls: 'timeline-header' });
        headerEl.createEl('h4', { text: `Timeline for ${moment().format('MMMM D, YYYY')}` });
        
        // Create controls
        const controlsEl = headerEl.createEl('div', { cls: 'timeline-controls' });
        const refreshBtn = controlsEl.createEl('button', { text: '🔄' });
        refreshBtn.setAttribute('title', 'Refresh Timeline');
        refreshBtn.addEventListener('click', async () => {
            this.clearCaches();
            await this.refreshView();
        });

        // Create timeline container
        this.timelineEl = mainContainer.createEl('div', { cls: 'timeline-container' });
        
        // Create splitter
        const splitter = mainContainer.createEl('div', { cls: 'timeline-splitter' });
        
        // Create unscheduled tasks area
        const unscheduledArea = mainContainer.createEl('div', { cls: 'unscheduled-tasks' });
        unscheduledArea.createEl('h6', { text: 'Unscheduled Tasks' });
        const dropZone = unscheduledArea.createEl('div', { 
            cls: 'unscheduled-drop-zone',
            attr: { 'data-time': 'unscheduled' }
        });
        this.setupDropZone(dropZone);

        // Setup splitter drag functionality
        this.setupSplitter(splitter, this.timelineEl, unscheduledArea);

        // Create time slots
        this.createTimeSlots();
        
        // Register file change handler
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                const startTime = performance.now();
                this.debugLog(`File modified: ${file.path}`);
                
                if (file instanceof TFile && file.extension === 'md') {
                    // Always clear the file cache and mark file as modified for markdown files
                    this.fileCache.delete(file.path);
                    this.modifiedFiles.add(file.path);
                    
                    // Schedule a debounced refresh to pick up any new tasks
                    this.debouncedRefresh();
                    
                    this.debugLog('Scheduled refresh for modified markdown file:', file.path);
                }
                
                const endTime = performance.now();
                this.debugLog(`File change handler complete: ${Math.round(endTime - startTime)}ms`);
            })
        );

        // Initial load
        await this.refreshView();
    }

    private createTimeSlots() {
        for (let hour = 0; hour < 24; hour++) {
            const timeSlot = this.timelineEl.createEl('div', { cls: 'time-slot' });
            timeSlot.style.height = `${this.hourHeight}px`;
            
            const timeLabel = timeSlot.createEl('div', { 
                cls: 'time-label',
                text: `${hour.toString().padStart(2, '0')}:00`
            });
            
            const dropZone = timeSlot.createEl('div', { 
                cls: 'time-drop-zone',
                attr: { 'data-hour': hour.toString() }
            });

            // Add time block creation handlers
            dropZone.addEventListener('mousedown', (e) => {
                this.isCreatingTimeBlock = true;
                this.timeBlockStart = hour;
            });

            dropZone.addEventListener('mouseover', (e) => {
                if (this.isCreatingTimeBlock && this.timeBlockStart !== null) {
                    this.showTimeBlockPreview(this.timeBlockStart, hour);
                }
            });
            
            this.timeSlots.set(hour, dropZone);
        }

        // Add mouseup handler to document
        document.addEventListener('mouseup', (e) => {
            if (this.isCreatingTimeBlock && this.timeBlockStart !== null) {
                // Get the current hour from the element under the mouse
                const element = document.elementFromPoint(e.clientX, e.clientY);
                const currentHour = element?.closest('.time-drop-zone')?.getAttribute('data-hour');
                
                this.createNewTimeBlock(
                    this.timeBlockStart,
                    currentHour ? parseInt(currentHour) : this.timeBlockStart
                );
                
                this.isCreatingTimeBlock = false;
                this.timeBlockStart = null;
            }
        });

        // Add scroll zoom handler to timeline container
        this.timelineEl.addEventListener('wheel', (e: WheelEvent) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                // Pass the relative Y position of the mouse in the container
                const rect = this.timelineEl.getBoundingClientRect();
                const mouseY = e.clientY - rect.top;
                this.zoom(zoomFactor, mouseY);
            }
        });
    }

    private setupDropZone(element: HTMLElement) {
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            element.addClass('drag-over');
        });

        element.addEventListener('dragleave', () => {
            element.removeClass('drag-over');
        });

        element.addEventListener('drop', async (e) => {
            e.preventDefault();
            element.removeClass('drag-over');
            const taskText = e.dataTransfer?.getData('text/plain');
            const timeSlot = element.dataset.time;
            
            if (taskText && timeSlot) {
                const taskKey = this.getTaskKey(taskText);
                const oldTaskEl = this.containerEl.querySelector(`[data-task="${taskKey}"]`);
                
                if (oldTaskEl) {
                    oldTaskEl.remove();
                }

                const taskIdentity = this.getTaskIdentity(taskText);
                this.scheduledTasks.set(taskKey, {
                    taskText: taskKey,
                    timeSlot: timeSlot === 'unscheduled' ? 'unscheduled' : parseInt(timeSlot),
                    metadata: taskIdentity.metadata
                });

                await this.saveScheduledTasks();
                this.createTaskElement(taskText, taskIdentity);
            }
        });
    }

    private async processFile(file: TFile, today: string): Promise<void> {
        const content = await this.app.vault.read(file);
        this.fileCache.set(file.path, content);
        
        // Keep track of tasks that existed in this file
        const previousTasksInFile = new Set(
            Array.from(this.taskCache.values())
                .filter(task => task.filePath === file.path)
                .map(task => task.identifier)
        );
        
        // Process new/updated tasks in the file
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.match(/^- \[[ x]\]/)) {
                const taskIdentity = this.getTaskIdentity(line);
                taskIdentity.filePath = file.path;
                
                const existingTask = this.taskCache.get(taskIdentity.identifier);
                if (!existingTask ||
                    existingTask.originalContent !== taskIdentity.originalContent) {
                    this.debugLog(`Task changed/new in ${file.path}:`, {
                        identifier: taskIdentity.identifier,
                        old: existingTask?.originalContent,
                        new: taskIdentity.originalContent
                    });
                    
                    this.taskCache.set(taskIdentity.identifier, taskIdentity);
                    
                    if (taskIdentity.metadata.dueDate && 
                        moment(taskIdentity.metadata.dueDate).format('YYYY-MM-DD') === today) {
                        await this.createTaskElement(line, taskIdentity);
                    }
                }
                previousTasksInFile.delete(taskIdentity.identifier);
            }
        }
        
        // Remove tasks that no longer exist in this file
        for (const taskId of previousTasksInFile) {
            const task = this.taskCache.get(taskId);
            if (task && task.filePath === file.path) {
                this.debugLog(`Removing task: ${taskId} from file: ${file.path}`);
                this.taskCache.delete(taskId);
                const taskEl = this.taskElements.get(taskId);
                if (taskEl) {
                    taskEl.remove();
                    this.taskElements.delete(taskId);
                }
            }
        }
    }

    private async loadTasks() {
        const startTime = performance.now();
        this.debugLog('Starting loadTasks()');
        
        const today = moment().format('YYYY-MM-DD');
        
        // If this is the initial load, process all files
        if (this.taskCache.size === 0) {
            const files = this.app.vault.getMarkdownFiles();
            this.debugLog(`Initial load - processing ${files.length} files`);
            
            for (const file of files) {
                await this.processFile(file, today);
            }
        } else {
            // For subsequent loads, only process modified files
            const modifiedFiles = Array.from(this.modifiedFiles)
                .map(path => this.app.vault.getAbstractFileByPath(path))
                .filter((file): file is TFile => file instanceof TFile);
                
            this.debugLog(`Incremental update - processing ${modifiedFiles.length} modified files:`, 
                Array.from(this.modifiedFiles));
            
            for (const file of modifiedFiles) {
                await this.processFile(file, today);
            }
            
            // Clear the modified files set after processing
            this.modifiedFiles.clear();
        }
        
        const endTime = performance.now();
        this.debugLog('Task loading complete', {
            timeMs: Math.round(endTime - startTime),
            totalTasks: this.taskCache.size,
            taskElements: this.taskElements.size
        });
    }

    private async loadScheduledTasks() {
        const today = moment().format('YYYY-MM-DD');
        const dailyNotes = this.app.vault.getMarkdownFiles().filter(file => 
            file.basename === today
        );

        if (dailyNotes.length > 0) {
            this.currentDayFile = dailyNotes[0];
            const content = await this.app.vault.read(this.currentDayFile);
            
            // Look for our scheduling data section
            const match = content.match(/```taskSchedule\n([\s\S]*?)\n```/);
            if (match) {
                try {
                    const scheduledTasks = JSON.parse(match[1]);
                    for (const [key, task] of Object.entries(scheduledTasks)) {
                        // Try to find the task by ID first, then by content
                        const files = this.app.vault.getMarkdownFiles();
                        let found = false;
                        
                        for (const file of files) {
                            const fileContent = await this.app.vault.read(file);
                            const lines = fileContent.split('\n');
                            const taskLine = lines.find(line => 
                                line.includes(`🆔 ${key}`) || 
                                this.getTaskIdentity(line).identifier === (task as ScheduledTask).taskText
                            );
                            
                            if (taskLine) {
                                const taskIdentity = this.getTaskIdentity(taskLine);
                                taskIdentity.filePath = file.path;
                                this.taskCache.set(taskIdentity.identifier, taskIdentity);
                                this.scheduledTasks.set(taskIdentity.identifier, {
                                    ...(task as ScheduledTask),
                                    taskText: taskIdentity.identifier,
                                    metadata: taskIdentity.metadata
                                });
                                found = true;
                                break;
                            }
                        }
                        
                        if (!found) {
                            console.warn('Could not find task:', key);
                        }
                    }
                } catch (e) {
                    console.error('Failed to parse scheduled tasks:', e);
                }
            }
        }
    }

    private async saveScheduledTasks() {
        if (!this.currentDayFile) {
            // Create today's file if it doesn't exist
            const today = moment().format('YYYY-MM-DD');
            this.currentDayFile = await this.app.vault.create(
                `${today}.md`,
                '# ' + moment().format('MMMM D, YYYY') + '\n\n```taskSchedule\n{}\n```'
            );
        }

        // Preserve completed tasks in their time slots
        const content = await this.app.vault.read(this.currentDayFile);
        const schedulingData = JSON.stringify(
            Object.fromEntries(
                Array.from(this.scheduledTasks.entries()).map(([key, task]) => {
                    // Keep the existing time slot even if the task is completed
                    return [key, task];
                })
            ), 
            null, 
            2
        );
        
        if (content.includes('```taskSchedule')) {
            const newContent = content.replace(
                /```taskSchedule\n[\s\S]*?\n```/,
                '```taskSchedule\n' + schedulingData + '\n```'
            );
            await this.app.vault.modify(this.currentDayFile, newContent);
        } else {
            await this.app.vault.modify(
                this.currentDayFile,
                content + '\n\n```taskSchedule\n' + schedulingData + '\n```'
            );
        }

        // Refresh the view after saving
        await this.refreshView();
    }

    private async loadTimeBlocks() {
        if (!this.currentDayFile) return;
        
        const content = await this.app.vault.read(this.currentDayFile);
        const match = content.match(/```timeBlocks\n([\s\S]*?)\n```/);
        
        if (match) {
            try {
                const timeBlocksData = JSON.parse(match[1]);
                
                // Process each block and its tasks
                for (const [blockId, blockData] of Object.entries(timeBlocksData)) {
                    const block = blockData as TimeBlock;
                    const processedTasks: string[] = [];
                    
                    // Process each task in the block
                    for (const taskInfo of block.tasks) {
                        const { id, text } = taskInfo as { id: string | null, text: string | null };
                        
                        // Try to find the task in files
                        const files = this.app.vault.getMarkdownFiles();
                        let found = false;
                        
                        for (const file of files) {
                            const fileContent = await this.app.vault.read(file);
                            const lines = fileContent.split('\n');
                            const taskLine = lines.find(line => 
                                (id && line.includes(`🆔 ${id}`)) || 
                                (text && this.getTaskIdentity(line).identifier === text)
                            );
                            
                            if (taskLine) {
                                const taskIdentity = this.getTaskIdentity(taskLine);
                                taskIdentity.filePath = file.path;
                                this.taskCache.set(taskIdentity.identifier, taskIdentity);
                                processedTasks.push(taskIdentity.identifier);
                                found = true;
                                break;
                            }
                        }
                        
                        if (!found) {
                            console.warn('Could not find task:', id || text);
                        }
                    }
                    
                    // Create the block with found tasks
                    this.timeBlocks.set(blockId, {
                        ...block,
                        tasks: processedTasks
                    });
                }
                
                // Render all blocks
                this.timeBlocks.forEach(block => {
                    this.renderTimeBlock(block, this.timelineEl);
                });
            } catch (e) {
                console.error('Failed to parse time blocks:', e);
            }
        }
    }

    private async refreshView() {
        const startTime = performance.now();
        this.debugLog('Starting refreshView()');
        
        // Store current scroll position
        const scrollPosition = this.timelineEl.scrollTop;

        try {
            // Load data in parallel but don't block the UI
            this.debugLog('Loading data...');
            const loadPromise = Promise.all([
                this.loadScheduledTasks(),
                this.loadTimeBlocks(),
                this.loadTasks()
            ]);

            // Create separate fragments for blocks and unscheduled tasks
            const blocksFragment = document.createDocumentFragment();
            
            // Wait for data loading to complete
            await loadPromise;
            this.debugLog('Data loading complete');
            
            // Update time blocks
            this.debugLog(`Rendering ${this.timeBlocks.size} time blocks`);
            this.timeBlocks.forEach(block => {
                this.renderTimeBlock(block, blocksFragment);
            });

            // Find the unscheduled drop zone
            const unscheduledDropZone = this.containerEl.querySelector('.unscheduled-drop-zone');
            if (unscheduledDropZone) {
                unscheduledDropZone.empty();
                
                let unscheduledCount = 0;
                // Add unscheduled tasks to the unscheduled drop zone
                this.taskElements.forEach((taskEl, identifier) => {
                    let isScheduled = false;
                    this.timeBlocks.forEach(block => {
                        if (block.tasks.includes(identifier)) {
                            isScheduled = true;
                        }
                    });

                    if (!isScheduled) {
                        unscheduledCount++;
                        const clonedTask = taskEl.cloneNode(true) as HTMLElement;
                        this.setupTaskDragListeners(clonedTask, identifier);
                        unscheduledDropZone.appendChild(clonedTask);
                    }
                });
                this.debugLog(`Rendered ${unscheduledCount} unscheduled tasks`);
            }
            
            // Batch update DOM for time blocks
            this.timelineEl.appendChild(blocksFragment);
            
            // Restore scroll position
            this.timelineEl.scrollTop = scrollPosition;
            
            const endTime = performance.now();
            this.debugLog('RefreshView complete', {
                timeMs: Math.round(endTime - startTime),
                taskElements: this.taskElements.size,
                timeBlocks: this.timeBlocks.size
            });
        } catch (error) {
            console.error('Error refreshing timeline view:', error);
            this.debugLog('Error in refreshView:', error);
        }
    }

    private async createTaskElement(taskText: string, taskIdentity: TaskIdentity): Promise<HTMLElement | null> {
        // Create task container
        const taskEl = document.createElement('div');
        taskEl.addClass('timeline-task');
        taskEl.setAttribute('data-task', taskIdentity.identifier);

        // Create task text container with checkbox
        const textEl = document.createElement('div');
        textEl.addClass('task-text');
        
        // Find current task status by searching files
        let currentTaskStatus = false;
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            const taskLine = lines.find(line => line.includes(taskIdentity.identifier));
            if (taskLine) {
                currentTaskStatus = taskLine.includes('- [x]');
                break;
            }
        }
        
        // Use Obsidian's markdown renderer for the checkbox
        const taskMarkdown = taskText
            .replace(/^- \[([ x])\]/, () => {
                return `<input type="checkbox" ${currentTaskStatus ? 'checked' : ''}>`;
            })
            // Strip all metadata emojis and their content
            .replace(/(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️) .*?(?=(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️)|$)/g, '')
            .trim();
        
        // Use Obsidian's markdown processor
        MarkdownRenderer.renderMarkdown(
            taskMarkdown,
            textEl,
            '',
            this
        );

        // Add click handler for checkbox
        const checkbox = textEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (checkbox) {
            checkbox.addEventListener('click', async (e) => {
                // Stop event propagation to prevent block events
                e.stopPropagation();
                e.preventDefault();

                const files = this.app.vault.getMarkdownFiles();
                this.debugLog('Searching through files for task');
                
                for (const file of files) {
                    const content = await this.app.vault.read(file);
                    const lines = content.split('\n');
                    const lineIndex = lines.findIndex(line => line.includes(taskIdentity.identifier));
                    
                    this.debugLog('Checking file', {
                        file: file.path,
                        lineFound: lineIndex !== -1
                    });
                    
                    if (lineIndex !== -1) {
                        const originalLine = lines[lineIndex];
                        const isCurrentlyChecked = originalLine.includes('- [x]');
                        
                        this.debugLog('Found task line', {
                            originalLine,
                            lineIndex,
                            currentCheckboxState: isCurrentlyChecked ? 'checked' : 'unchecked'
                        });
                        
                        const newContent = lines.map((line, index) => {
                            if (index === lineIndex) {
                                let newLine;
                                if (!isCurrentlyChecked) {
                                    // Task is currently unchecked, so check it
                                    const beforeReplace = line;
                                    newLine = line.replace(/^-\s*\[\s*\]/, '- [x]') + 
                                           (line.includes('✅') ? '' : ` ✅ ${moment().format('YYYY-MM-DD')}`);
                                    this.debugLog('Checkbox replacement (checking):', {
                                        before: beforeReplace,
                                        after: newLine,
                                        regexMatched: beforeReplace !== newLine
                                    });
                                } else {
                                    // Task is currently checked, so uncheck it
                                    const beforeReplace = line;
                                    newLine = line.replace(/^-\s*\[x\]/, '- [ ]').replace(/✅\s*\d{4}-\d{2}-\d{2}/, '').trim();
                                    this.debugLog('Checkbox replacement (unchecking):', {
                                        before: beforeReplace,
                                        after: newLine,
                                        regexMatched: beforeReplace !== newLine
                                    });
                                }

                                // Update checkbox state to match file
                                checkbox.checked = !isCurrentlyChecked;

                                this.debugLog('Modifying line', {
                                    from: originalLine,
                                    to: newLine,
                                    newCheckboxState: checkbox.checked
                                });
                                return newLine;
                            }
                            return line;
                        }).join('\n');
                        
                        this.debugLog('Attempting to modify file');
                        await this.app.vault.modify(file, newContent);
                        this.debugLog('File modified successfully');
                        break;
                    }
                }
                this.debugLog('Checkbox click handler completed');
            });
        }
        
        taskEl.appendChild(textEl);

        // Add time estimate if available
        if (taskIdentity.metadata.timeEstimate) {
            const estimateEl = document.createElement('div');
            estimateEl.addClass('task-estimate');
            estimateEl.setText(`Estimated: ${this.formatTimeEstimate(taskIdentity.metadata.timeEstimate)}`);
            taskEl.appendChild(estimateEl);
        }

        // Add drag listeners
        this.setupTaskDragListeners(taskEl, taskIdentity.identifier);

        // Store reference using identifier
        this.taskElements.set(taskIdentity.identifier, taskEl);

        return taskEl;
    }

    private formatTimeEstimate(estimate: { days: number, hours: number, minutes: number }): string {
        const parts = [];
        if (estimate.days > 0) parts.push(`${estimate.days}d`);
        if (estimate.hours > 0) parts.push(`${estimate.hours}h`);
        if (estimate.minutes > 0) parts.push(`${estimate.minutes}m`);
        return parts.join(' ');
    }

    private getTaskKey(taskText: string): string {
        // Get the task content after the checkbox
        const match = taskText.match(/^- \[[ x]\] (.*)/);
        return match ? match[1] : taskText;
    }

    private async createNewTimeBlock(startHour: number, endHour: number) {
        const id = `block-${Date.now()}`;
        const title = await this.promptForBlockTitle();
        if (!title) return;

        const timeBlock: TimeBlock = {
            id,
            title,
            startHour: Math.min(startHour, endHour),
            endHour: Math.max(startHour, endHour) + 1,  // +1 because end hour is exclusive
            tasks: []
        };

        this.timeBlocks.set(id, timeBlock);
        this.renderTimeBlock(timeBlock, this.timelineEl);
        await this.saveTimeBlocks();
    }

    private getTaskIdentifier(task: string | { id: string | null; text: string | null; timeSlot: number }): string {
        if (typeof task === 'string') {
            return task;
        }
        return task.id || task.text || '';
    }

    private renderTimeBlock(block: TimeBlock, parent: DocumentFragment | HTMLElement) {
        // Remove existing block if it exists
        const existingBlock = this.timelineEl.querySelector(`[data-block-id="${block.id}"]`);
        if (existingBlock) {
            existingBlock.remove();
        }

        const blockEl = document.createElement('div');
        blockEl.addClass('time-block');
        blockEl.setAttribute('data-block-id', block.id);
        
        const top = block.startHour * this.hourHeight;
        const height = (block.endHour - block.startHour) * this.hourHeight;
        
        blockEl.style.top = `${top}px`;
        blockEl.style.height = `${height}px`;
        
        const titleEl = blockEl.createEl('div', { 
            cls: 'time-block-title',
            text: block.title
        });

        // Add resize handles
        const topHandle = blockEl.createEl('div', { cls: 'time-block-handle top-handle' });
        const bottomHandle = blockEl.createEl('div', { cls: 'time-block-handle bottom-handle' });

        // Setup drag handlers for the block
        this.setupBlockDragHandlers(blockEl, block.id);
        
        // Setup resize handlers
        this.setupBlockResizeHandlers(blockEl, block.id, topHandle, bottomHandle);

        this.setupBlockDropZone(blockEl, block.id);

        block.tasks.forEach(task => {
            this.renderTaskInBlock(this.getTaskIdentifier(task), blockEl);
        });

        parent.appendChild(blockEl);
    }

    private async renderTaskInBlock(taskKey: string, container: HTMLElement) {
        // First get the latest task content from cache
        const taskIdentity = this.taskCache.get(taskKey);
        if (!taskIdentity) {
            // Try to find task by ID in files if not in cache
            const files = this.app.vault.getMarkdownFiles();
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const lines = content.split('\n');
                const taskLine = lines.find(line => 
                    line.includes(`🆔 ${taskKey}`) || 
                    this.getTaskIdentity(line).identifier === taskKey
                );
                if (taskLine) {
                    const newIdentity = this.getTaskIdentity(taskLine);
                    newIdentity.filePath = file.path;
                    this.taskCache.set(taskKey, newIdentity);
                    const taskEl = await this.createTaskElement(taskLine, newIdentity);
                    if (taskEl) {
                        container.appendChild(taskEl);
                    }
                    return;
                }
            }
            console.warn('Task not found in cache or files:', taskKey);
            return;
        }

        // Create a new task element with the latest content
        const taskEl = await this.createTaskElement(taskIdentity.originalContent, taskIdentity);
        if (taskEl) {
            container.appendChild(taskEl);
        }
    }

    private async promptForBlockTitle(): Promise<string | null> {
        const modal = new TimeBlockModal(this.app);
        return await modal.openAndGetValue();
    }

    private showTimeBlockPreview(startHour: number, currentHour: number) {
        // Remove any existing preview
        const existingPreview = this.timelineEl.querySelector('.time-block-preview');
        if (existingPreview) {
            existingPreview.remove();
        }

        // Create preview element
        const previewEl = document.createElement('div');
        previewEl.addClass('time-block-preview', 'time-block');
        
        // Calculate position
        const start = Math.min(startHour, currentHour);
        const end = Math.max(startHour, currentHour) + 1;
        const top = start * this.hourHeight;
        const height = (end - start) * this.hourHeight;
        
        previewEl.style.top = `${top}px`;
        previewEl.style.height = `${height}px`;
        
        this.timelineEl.appendChild(previewEl);
    }

    private async saveTimeBlocks() {
        if (!this.currentDayFile) {
            const today = moment().format('YYYY-MM-DD');
            this.currentDayFile = await this.app.vault.create(
                `${today}.md`,
                '# ' + moment().format('MMMM D, YYYY') + '\n\n```timeBlocks\n{}\n```'
            );
        }

        const content = await this.app.vault.read(this.currentDayFile);
        
        // Convert timeBlocks to a format that includes both ID and text for each task
        const timeBlocksData = Object.fromEntries(
            Array.from(this.timeBlocks.entries()).map(([blockId, block]) => {
                const tasksWithInfo = block.tasks.map(task => {
                    if (typeof task === 'object') {
                        return task;
                    }
                    const taskIdentity = this.taskCache.get(task);
                    if (taskIdentity) {
                        return {
                            id: taskIdentity.identifier,
                            text: taskIdentity.originalContent.replace(/^- \[[ x]\] /, '').trim(),
                            timeSlot: block.startHour
                        };
                    }
                    this.debugLog('Warning: Task not found in cache during save:', task);
                    return { id: task, text: null, timeSlot: block.startHour };
                });

                return [blockId, {
                    ...block,
                    tasks: tasksWithInfo
                }];
            })
        );

        const timeBlocksJson = JSON.stringify(timeBlocksData, null, 2);

        if (content.includes('```timeBlocks')) {
            const newContent = content.replace(
                /```timeBlocks\n[\s\S]*?\n```/,
                '```timeBlocks\n' + timeBlocksJson + '\n```'
            );
            await this.app.vault.modify(this.currentDayFile, newContent);
        } else {
            await this.app.vault.modify(
                this.currentDayFile,
                content + '\n\n```timeBlocks\n' + timeBlocksJson + '\n```'
            );
        }
    }

    private setupBlockDropZone(element: HTMLElement, blockId: string) {
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            element.addClass('drag-over');
        });

        element.addEventListener('dragleave', () => {
            element.removeClass('drag-over');
        });

        element.addEventListener('drop', async (e) => {
            e.preventDefault();
            element.removeClass('drag-over');
            const rawIdentifier = e.dataTransfer?.getData('text/plain');
            if (!rawIdentifier) return;
            
            const taskIdentifier = rawIdentifier;
            
            if (this.timeBlocks.has(blockId)) {
                const timeBlock = this.timeBlocks.get(blockId)!;

                if (!timeBlock.tasks.some(task => 
                    typeof task === 'string' 
                        ? task === taskIdentifier 
                        : task.id === taskIdentifier
                )) {
                    // Remove task from any other blocks
                    this.timeBlocks.forEach(block => {
                        block.tasks = block.tasks.filter(task => 
                            typeof task === 'string'
                                ? task !== taskIdentifier
                                : task.id !== taskIdentifier
                        );
                    });
                    
                    // Add task to this block and ensure it has an ID
                    let currentTaskIdentity = this.taskCache.get(taskIdentifier);
                    if (currentTaskIdentity) {
                        // Ensure task has an ID
                        let taskContent = currentTaskIdentity.originalContent;
                        let taskId: string;
                        
                        if (!taskContent.includes('🆔')) {
                            taskContent = await this.addIdToTask(taskContent);
                            // Update the task in its file
                            await this.updateTaskInFile(
                                currentTaskIdentity.originalContent,
                                taskContent,
                                currentTaskIdentity.filePath
                            );
                            
                            // Update cache with new content
                            const newIdentity = this.getTaskIdentity(taskContent);
                            newIdentity.filePath = currentTaskIdentity.filePath;
                            this.taskCache.set(newIdentity.identifier, newIdentity);
                            currentTaskIdentity = newIdentity;
                        }
                        
                        // Extract the task ID
                        const idMatch = taskContent.match(/🆔 (task_[a-zA-Z0-9_]+)/);
                        taskId = idMatch ? idMatch[1] : currentTaskIdentity.identifier;

                        // Create task info object
                        const taskInfo = {
                            id: taskId,
                            text: taskContent.replace(/^- \[[ x]\] /, '').trim(),
                            timeSlot: timeBlock.startHour
                        };

                        timeBlock.tasks.push(taskInfo);
                    } else {
                        this.debugLog('Task not found in cache:', taskIdentifier);
                    }
                    
                    // Clear and re-render tasks
                    element.empty();
                    for (const task of timeBlock.tasks) {
                        const taskId = typeof task === 'string' ? task : task.id;
                        if (taskId) {
                            await this.renderTaskInBlock(taskId, element);
                        } else {
                            this.debugLog('Warning: Invalid task object:', task);
                        }
                    }
                    
                    await this.saveTimeBlocks();
                }
            }
        });
    }

    private clearCaches() {
        this.taskCache.clear();
        this.fileCache.clear();
    }

    onunload() {
        this.clearCaches();
    }

    // Add this new method to handle task drag events
    private setupTaskDragListeners(taskEl: HTMLElement, identifier: string) {
        taskEl.setAttribute('draggable', 'true');
        taskEl.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', identifier);
            taskEl.addClass('dragging');
        });

        taskEl.addEventListener('dragend', () => {
            taskEl.removeClass('dragging');
        });
    }

    private zoom(factor: number, mouseY?: number) {
        const newHeight = Math.min(Math.max(this.hourHeight * factor, this.minHourHeight), this.maxHourHeight);
        if (newHeight !== this.hourHeight) {
            // If mouseY is provided, maintain the same timeline position under cursor
            if (mouseY !== undefined) {
                const container = this.timelineEl;
                const scrollBefore = container.scrollTop;
                const hourUnderMouse = (scrollBefore + mouseY) / this.hourHeight;
                
                this.hourHeight = newHeight;
                
                // Update all elements
                this.timelineEl.querySelectorAll('.time-slot').forEach((slot: HTMLElement) => {
                    slot.style.height = `${this.hourHeight}px`;
                });
                this.timeBlocks.forEach(block => {
                    const blockEl = this.timelineEl.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement;
                    if (blockEl) {
                        blockEl.style.top = `${block.startHour * this.hourHeight}px`;
                        blockEl.style.height = `${(block.endHour - block.startHour) * this.hourHeight}px`;
                    }
                });

                // Adjust scroll to keep the same hour under mouse
                const newScrollTop = (hourUnderMouse * this.hourHeight) - mouseY;
                container.scrollTop = newScrollTop;
            } else {
                // Regular zoom without mouse position
                this.hourHeight = newHeight;
                this.timelineEl.querySelectorAll('.time-slot').forEach((slot: HTMLElement) => {
                    slot.style.height = `${this.hourHeight}px`;
                });
                this.timeBlocks.forEach(block => {
                    const blockEl = this.timelineEl.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement;
                    if (blockEl) {
                        blockEl.style.top = `${block.startHour * this.hourHeight}px`;
                        blockEl.style.height = `${(block.endHour - block.startHour) * this.hourHeight}px`;
                    }
                });
            }
        }
    }

    private getTaskIdentity(taskText: string): TaskIdentity {
        const metadata = TaskParser.parseTask(taskText, this.plugin.settings);
        
        // First try to get ID from metadata
        const idMetadataMatch = taskText.match(/🆔 (task_[a-zA-Z0-9_]+)/);
        if (idMetadataMatch) {
            return {
                identifier: idMetadataMatch[1],
                originalContent: taskText,
                metadata,
                filePath: ''
            };
        }

        // Get the core task content without checkbox and metadata
        const baseContent = taskText
            .replace(/^- \[[ x]\] /, '')  // Remove checkbox
            .replace(/(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️) .*?(?=(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️)|$)/g, '')  // Remove metadata
            .trim();

        return {
            identifier: baseContent,
            originalContent: taskText,
            metadata,
            filePath: ''
        };
    }

    private generateTaskId(): string {
        return 'task_' + Math.random().toString(36).substr(2, 9);
    }

    private async addIdToTask(taskText: string): Promise<string> {
        if (taskText.includes('🆔')) {
            return taskText; // Already has an ID
        }

        const id = this.generateTaskId();
        // Add ID at the end of the task text
        return taskText.trim() + ` 🆔 ${id}`;
    }

    private async updateTaskInFile(originalTask: string, newTask: string, filePath: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const content = await this.app.vault.read(file);
            const newContent = content.replace(originalTask, newTask);
            await this.app.vault.modify(file, newContent);
        }
    }

    private setupBlockDragHandlers(blockEl: HTMLElement, blockId: string) {
        let isDragging = false;
        let startY = 0;
        let startTop = 0;
        let originalBlock: TimeBlock;

        blockEl.addEventListener('mousedown', (e: MouseEvent) => {
            // Only start drag if clicking an empty area (not on tasks, handles, or title)
            const target = e.target as HTMLElement;
            if (target === blockEl || // Direct click on block
                (target.parentElement === blockEl && !target.classList.contains('time-block-handle') && 
                !target.classList.contains('time-block-title') && 
                !target.classList.contains('timeline-task'))) {
                isDragging = true;
                startY = e.clientY;
                startTop = blockEl.offsetTop;
                originalBlock = {...this.timeBlocks.get(blockId)!};
                blockEl.addClass('dragging');
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', (e: MouseEvent) => {
            if (!isDragging) return;

            const deltaY = e.clientY - startY;
            const newTop = startTop + deltaY;
            
            // Convert pixel position to hours
            const newStartHour = Math.round(newTop / this.hourHeight);
            const duration = originalBlock.endHour - originalBlock.startHour;
            
            // Ensure block stays within timeline bounds
            if (newStartHour >= 0 && newStartHour + duration <= 24) {
                blockEl.style.top = `${newStartHour * this.hourHeight}px`;
                
                // Update block times
                const block = this.timeBlocks.get(blockId)!;
                block.startHour = newStartHour;
                block.endHour = newStartHour + duration;
            }
        });

        document.addEventListener('mouseup', async () => {
            if (isDragging) {
                isDragging = false;
                blockEl.removeClass('dragging');
                await this.saveTimeBlocks();
            }
        });
    }

    private setupBlockResizeHandlers(
        blockEl: HTMLElement, 
        blockId: string, 
        topHandle: HTMLElement, 
        bottomHandle: HTMLElement
    ) {
        let isResizing = false;
        let resizeType: 'top' | 'bottom' = 'top';
        let startY = 0;
        let startTop = 0;
        let startHeight = 0;
        let originalBlock: TimeBlock;

        const startResize = (e: MouseEvent, type: 'top' | 'bottom') => {
            isResizing = true;
            resizeType = type;
            startY = e.clientY;
            startTop = blockEl.offsetTop;
            startHeight = blockEl.offsetHeight;
            originalBlock = {...this.timeBlocks.get(blockId)!};
            blockEl.addClass('resizing');
            e.preventDefault();
            e.stopPropagation();
        };

        topHandle.addEventListener('mousedown', (e) => startResize(e, 'top'));
        bottomHandle.addEventListener('mousedown', (e) => startResize(e, 'bottom'));

        document.addEventListener('mousemove', (e: MouseEvent) => {
            if (!isResizing) return;

            const deltaY = e.clientY - startY;
            const block = this.timeBlocks.get(blockId)!;

            if (resizeType === 'top') {
                const newTop = startTop + deltaY;
                const newStartHour = Math.round(newTop / this.hourHeight);
                
                if (newStartHour >= 0 && newStartHour < block.endHour) {
                    blockEl.style.top = `${newStartHour * this.hourHeight}px`;
                    blockEl.style.height = `${(block.endHour - newStartHour) * this.hourHeight}px`;
                    block.startHour = newStartHour;
                }
            } else {
                const newHeight = startHeight + deltaY;
                const newEndHour = Math.round((startTop + newHeight) / this.hourHeight);
                
                if (newEndHour <= 24 && newEndHour > block.startHour) {
                    blockEl.style.height = `${(newEndHour - block.startHour) * this.hourHeight}px`;
                    block.endHour = newEndHour;
                }
            }
        });

        document.addEventListener('mouseup', async () => {
            if (isResizing) {
                isResizing = false;
                blockEl.removeClass('resizing');
                await this.saveTimeBlocks();
            }
        });
    }

    private setupSplitter(
        splitter: HTMLElement, 
        timelineEl: HTMLElement, 
        unscheduledEl: HTMLElement
    ) {
        let isResizing = false;
        let startY = 0;
        let startHeight = 0;

        splitter.addEventListener('mousedown', (e: MouseEvent) => {
            isResizing = true;
            startY = e.clientY;
            startHeight = timelineEl.offsetHeight;
            document.body.addClass('timeline-resizing');
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e: MouseEvent) => {
            if (!isResizing) return;

            const deltaY = e.clientY - startY;
            const newHeight = Math.max(200, startHeight + deltaY); // Minimum height of 200px
            
            timelineEl.style.height = `${newHeight}px`;
            timelineEl.style.flex = '0 0 auto';
            unscheduledEl.style.flex = '1 1 auto';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.removeClass('timeline-resizing');
            }
        });
    }

    private debugLog(message: string, data?: any) {
        if (this.debugEnabled) {
            if (data) {
                console.log(`[Timeline Debug] ${message}`, data);
            } else {
                console.log(`[Timeline Debug] ${message}`);
            }
        }
    }
}

class TimeBlockModal extends Modal {
    private title: string = '';
    private resolvePromise: ((value: string | null) => void) | null = null;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create Time Block' });

        const textComponent = new Setting(contentEl)
            .setName('Title')
            .addText(text => text
                .setValue(this.title)
                .onChange(value => this.title = value));

        const inputEl = (textComponent.components[0] as any).inputEl as HTMLInputElement;

        // Focus and select all text
        inputEl.focus();
        
        // Handle Enter key
        inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                if (this.resolvePromise) {
                    this.resolvePromise(this.title || null);
                }
                this.close();
            }
        });

        // Remove the buttons, just use Enter/Escape
        contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (this.resolvePromise) {
                    this.resolvePromise(null);
                }
                this.close();
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (this.resolvePromise) {
            this.resolvePromise(null);
        }
    }

    async openAndGetValue(): Promise<string | null> {
        this.open();
        return new Promise(resolve => {
            this.resolvePromise = resolve;
        });
    }
} 