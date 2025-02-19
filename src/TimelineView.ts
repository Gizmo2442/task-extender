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
        const zoomInBtn = controlsEl.createEl('button', { text: '🔍+' });
        const zoomOutBtn = controlsEl.createEl('button', { text: '🔍-' });

        zoomInBtn.addEventListener('click', () => this.zoom(1.2));
        zoomOutBtn.addEventListener('click', () => this.zoom(0.8));

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
            this.app.vault.on('modify', (file) => {
                if (this.currentDayFile && file.path === this.currentDayFile.path) {
                    this.debouncedRefresh();
                }
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

    private async loadTasks() {
        const today = moment().format('YYYY-MM-DD');
        const files = this.app.vault.getMarkdownFiles();
        
        // Batch file reads and cache results
        const fileReads = files.map(async file => {
            if (!this.fileCache.has(file.path)) {
                const content = await this.app.vault.read(file);
                this.fileCache.set(file.path, content);
            }
            return {
                file,
                content: this.fileCache.get(file.path)!
            };
        });
        
        const fileContents = await Promise.all(fileReads);
        
        // Process all files in a single pass
        for (const {file, content} of fileContents) {
            const lines = content.split('\n');
            for (const line of lines) {
                if (line.match(/^- \[[ x]\]/)) {
                    const taskIdentity = this.getTaskIdentity(line);
                    
                    if (!this.taskCache.has(taskIdentity.identifier)) {
                        this.taskCache.set(taskIdentity.identifier, taskIdentity);
                    }
                    
                    if (taskIdentity.metadata.dueDate && 
                        moment(taskIdentity.metadata.dueDate).format('YYYY-MM-DD') === today) {
                        this.createTaskElement(line, taskIdentity);
                    }
                }
            }
        }
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
                        const taskIdentity = this.getTaskIdentity((task as ScheduledTask).taskText);
                        this.scheduledTasks.set(key, {
                            ...(task as ScheduledTask),
                            metadata: taskIdentity.metadata
                        });
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
                this.timeBlocks = new Map(Object.entries(timeBlocksData));
                
                // First create all task elements
                const today = moment().format('YYYY-MM-DD');
                const files = this.app.vault.getMarkdownFiles();
                
                for (const file of files) {
                    const content = await this.app.vault.read(file);
                    const lines = content.split('\n');
                    
                    for (const line of lines) {
                        if (line.match(/^- \[[ x]\]/)) {
                            const metadata = TaskParser.parseTask(line, this.plugin.settings);
                            if (metadata.dueDate && moment(metadata.dueDate).format('YYYY-MM-DD') === today) {
                                this.createTaskElement(line, this.getTaskIdentity(line));
                            }
                        }
                    }
                }

                // Then render all blocks with their tasks
                this.timeBlocks.forEach(block => {
                    this.renderTimeBlock(block, this.timelineEl);
                });
            } catch (e) {
                console.error('Failed to parse time blocks:', e);
            }
        }
    }

    private async refreshView() {
        // Store current scroll position
        const scrollPosition = this.timelineEl.scrollTop;

        // Create separate fragments for blocks and unscheduled tasks
        const blocksFragment = document.createDocumentFragment();
        
        // Remove existing elements but keep references
        const existingBlocks = Array.from(this.timelineEl.querySelectorAll('.time-block'));
        const existingTasks = Array.from(this.timelineEl.querySelectorAll('.timeline-task'));
        
        existingBlocks.forEach(el => el.remove());
        existingTasks.forEach(el => el.remove());
        
        // Load data in parallel
        await Promise.all([
            this.loadScheduledTasks(),
            this.loadTimeBlocks(),
            this.loadTasks()
        ]);
        
        // Render time blocks into blocks fragment
        this.timeBlocks.forEach(block => {
            this.renderTimeBlock(block, blocksFragment);
        });

        // Find the unscheduled drop zone
        const unscheduledDropZone = this.containerEl.querySelector('.unscheduled-drop-zone');
        if (unscheduledDropZone) {
            unscheduledDropZone.empty();
            
            // Add unscheduled tasks to the unscheduled drop zone
            this.taskElements.forEach((taskEl, identifier) => {
                // Check if task is not in any time block
                let isScheduled = false;
                this.timeBlocks.forEach(block => {
                    if (block.tasks.includes(identifier)) {
                        isScheduled = true;
                    }
                });

                if (!isScheduled) {
                    const clonedTask = taskEl.cloneNode(true) as HTMLElement;
                    // Re-attach drag event listeners
                    this.setupTaskDragListeners(clonedTask, identifier);
                    unscheduledDropZone.appendChild(clonedTask);
                }
            });
        }
        
        // Batch update DOM for time blocks
        this.timelineEl.appendChild(blocksFragment);
        
        // Restore scroll position
        this.timelineEl.scrollTop = scrollPosition;
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
        const taskMarkdown = taskText.replace(/^- \[([ x])\]/, () => {
            return `<input type="checkbox" ${currentTaskStatus ? 'checked' : ''}>`;
        });
        
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
                e.stopPropagation();
                const files = this.app.vault.getMarkdownFiles();
                for (const file of files) {
                    const content = await this.app.vault.read(file);
                    const lines = content.split('\n');
                    const lineIndex = lines.findIndex(line => line.includes(taskIdentity.identifier));
                    
                    if (lineIndex !== -1) {
                        const originalLine = lines[lineIndex];
                        const newContent = lines.map((line, index) => {
                            if (index === lineIndex) {
                                if (checkbox.checked) {
                                    // Add completion date when checking
                                    return originalLine.replace(/^- \[ \]/, '- [x]') + 
                                           (originalLine.includes('✅') ? '' : ` ✅ ${moment().format('YYYY-MM-DD')}`);
                                } else {
                                    // Remove completion date when unchecking
                                    return originalLine.replace(/^- \[x\]/, '- [ ]').replace(/✅ \d{4}-\d{2}-\d{2}/, '').trim();
                                }
                            }
                            return line;
                        }).join('\n');
                        
                        await this.app.vault.modify(file, newContent);
                        
                        // Update the task's display
                        const updatedTaskIdentity = this.getTaskIdentity(lines[lineIndex]);
                        this.taskCache.set(updatedTaskIdentity.identifier, updatedTaskIdentity);
                        
                        // Re-render the task element
                        const newTaskEl = await this.createTaskElement(lines[lineIndex], updatedTaskIdentity);
                        if (newTaskEl) {
                            taskEl.replaceWith(newTaskEl);
                        }
                        
                        break;
                    }
                }
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

        block.tasks.forEach(taskKey => {
            this.renderTaskInBlock(taskKey, blockEl);
        });

        parent.appendChild(blockEl);
    }

    private async renderTaskInBlock(taskKey: string, container: HTMLElement) {
        // First get the latest task content from cache
        const taskIdentity = this.taskCache.get(taskKey);
        if (!taskIdentity) {
            console.warn('Task not found in cache:', taskKey);
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
        const timeBlocksData = JSON.stringify(
            Object.fromEntries(this.timeBlocks),
            null,
            2
        );

        if (content.includes('```timeBlocks')) {
            const newContent = content.replace(
                /```timeBlocks\n[\s\S]*?\n```/,
                '```timeBlocks\n' + timeBlocksData + '\n```'
            );
            await this.app.vault.modify(this.currentDayFile, newContent);
        } else {
            await this.app.vault.modify(
                this.currentDayFile,
                content + '\n\n```timeBlocks\n' + timeBlocksData + '\n```'
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
            const taskIdentifier = e.dataTransfer?.getData('text/plain');
            
            if (taskIdentifier && this.timeBlocks.has(blockId)) {
                const timeBlock = this.timeBlocks.get(blockId)!;
                if (!timeBlock.tasks.includes(taskIdentifier)) {
                    // Remove task from any other blocks
                    this.timeBlocks.forEach(block => {
                        block.tasks = block.tasks.filter(t => t !== taskIdentifier);
                    });
                    
                    // Add task to this block
                    timeBlock.tasks.push(taskIdentifier);
                    
                    // Clear and re-render tasks
                    element.empty();
                    timeBlock.tasks.forEach(id => this.renderTaskInBlock(id, element));
                    
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
        
        // Try to get plugin ID using unicode escape sequence
        const idMatch = taskText.match(/\u0000\u0000 ([a-zA-Z0-9]+)/);
        if (idMatch) {
            return {
                identifier: idMatch[1],
                originalContent: taskText,
                metadata
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
            metadata
        };
    }

    private setupBlockDragHandlers(blockEl: HTMLElement, blockId: string) {
        let isDragging = false;
        let startY = 0;
        let startTop = 0;
        let originalBlock: TimeBlock;

        blockEl.addEventListener('mousedown', (e: MouseEvent) => {
            // Only start drag if clicking the title area
            const target = e.target as HTMLElement;
            if (!target.classList.contains('time-block-handle') && 
                !target.classList.contains('timeline-task')) {
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