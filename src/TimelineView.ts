import { View, WorkspaceLeaf, moment, TFile, MarkdownRenderer, Modal, Setting, App } from 'obsidian';
import type TaskPlannerPlugin from '../main';
import { TaskParser, type TaskMetadata } from './taskParser';
import type { ScheduledTask } from './models/ScheduledTask';
import type { TimeBlock } from './models/TimeBlock';
import { debounce } from 'obsidian';

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
    private taskCache: Map<string, {content: string, metadata: TaskMetadata}> = new Map();
    private fileCache: Map<string, string> = new Map();
    private refreshDebounceTimer: number | null = null;
    private debouncedRefresh: () => void;

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
        
        // Create timeline container
        this.timelineEl = mainContainer.createEl('div', { cls: 'timeline-container' });
        
        // Create unscheduled tasks area
        const unscheduledArea = mainContainer.createEl('div', { cls: 'unscheduled-tasks' });
        unscheduledArea.createEl('h6', { text: 'Unscheduled Tasks' });
        const dropZone = unscheduledArea.createEl('div', { 
            cls: 'unscheduled-drop-zone',
            attr: { 'data-time': 'unscheduled' }
        });
        this.setupDropZone(dropZone);

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

                const metadata = TaskParser.parseTask(taskText, this.plugin.settings);
                this.scheduledTasks.set(taskKey, {
                    taskText: taskKey,
                    timeSlot: timeSlot === 'unscheduled' ? 'unscheduled' : parseInt(timeSlot),
                    metadata
                });

                await this.saveScheduledTasks();
                this.createTaskElement(taskText, metadata);
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
                    const taskKey = this.getTaskKey(line);
                    
                    if (!this.taskCache.has(taskKey)) {
                        const metadata = TaskParser.parseTask(line, this.plugin.settings);
                        this.taskCache.set(taskKey, {content: line, metadata});
                    }
                    
                    const cached = this.taskCache.get(taskKey)!;
                    if (cached.metadata.dueDate && 
                        moment(cached.metadata.dueDate).format('YYYY-MM-DD') === today) {
                        this.createTaskElement(cached.content, cached.metadata);
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
                    this.scheduledTasks = new Map(Object.entries(scheduledTasks));
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
                                this.createTaskElement(line, metadata);
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
            this.taskElements.forEach((taskEl, taskKey) => {
                // Check if task is not in any time block
                let isScheduled = false;
                this.timeBlocks.forEach(block => {
                    if (block.tasks.includes(taskKey)) {
                        isScheduled = true;
                    }
                });

                if (!isScheduled) {
                    const clonedTask = taskEl.cloneNode(true) as HTMLElement;
                    // Re-attach drag event listeners
                    this.setupTaskDragListeners(clonedTask, taskKey);
                    unscheduledDropZone.appendChild(clonedTask);
                }
            });
        }
        
        // Batch update DOM for time blocks
        this.timelineEl.appendChild(blocksFragment);
        
        // Restore scroll position
        this.timelineEl.scrollTop = scrollPosition;
    }

    private createTaskElement(taskText: string, metadata: TaskMetadata): HTMLElement | null {
        const taskKey = this.getTaskKey(taskText);
        const scheduledTask = this.scheduledTasks.get(taskKey);
        
        // Create task container
        const taskEl = document.createElement('div');
        taskEl.addClass('timeline-task');
        taskEl.setAttribute('data-task', taskKey);

        // Create task text container with checkbox
        const textEl = document.createElement('div');
        textEl.addClass('task-text');
        
        // Use Obsidian's markdown renderer for the checkbox
        const taskMarkdown = taskText.replace(/^- \[([ x])\]/, (match, checked) => {
            return `<input type="checkbox" ${checked === 'x' ? 'checked' : ''}>`;
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
                    // Look for the task content instead of the full task text
                    const lineIndex = lines.findIndex(line => line.includes(taskKey));
                    
                    if (lineIndex !== -1) {
                        const newContent = lines.map((line, index) => {
                            if (index === lineIndex) {
                                return checkbox.checked 
                                    ? `- [x] ${taskKey}`
                                    : `- [ ] ${taskKey}`;
                            }
                            return line;
                        }).join('\n');
                        
                        await this.app.vault.modify(file, newContent);
                        break;
                    }
                }
            });
        }
        
        taskEl.appendChild(textEl);

        // Add time estimate if available
        if (metadata.timeEstimate) {
            const estimateEl = document.createElement('div');
            estimateEl.addClass('task-estimate');
            estimateEl.setText(`Estimated: ${this.formatTimeEstimate(metadata.timeEstimate)}`);
            taskEl.appendChild(estimateEl);
        }

        // Add drag listeners
        this.setupTaskDragListeners(taskEl, taskKey);

        // Store reference to element
        this.taskElements.set(taskKey, taskEl);

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
        const blockEl = document.createElement('div');
        blockEl.addClass('time-block');
        
        // Calculate position based on hours
        const hourHeight = 40;
        const top = block.startHour * hourHeight;
        const height = (block.endHour - block.startHour) * hourHeight;
        
        blockEl.style.top = `${top}px`;
        blockEl.style.height = `${height}px`;
        
        const titleEl = blockEl.createEl('div', { 
            cls: 'time-block-title',
            text: block.title
        });

        // Make the block a drop target for tasks
        this.setupBlockDropZone(blockEl, block.id);

        // Render existing tasks
        block.tasks.forEach(taskKey => {
            this.renderTaskInBlock(taskKey, blockEl);
        });

        parent.appendChild(blockEl);
    }

    private renderTaskInBlock(taskKey: string, container: HTMLElement) {
        const taskEl = this.taskElements.get(taskKey);
        if (taskEl) {
            const clonedTask = taskEl.cloneNode(true) as HTMLElement;
            
            // Remove the date from the task text
            const taskText = clonedTask.querySelector('.task-text') as HTMLElement;
            if (taskText) {
                const text = taskText.textContent || '';
                const dateRemoved = text.replace(/📅 \d{4}-\d{2}-\d{2}/, '').trim();
                
                // Render without the list item markup
                taskText.empty();
                MarkdownRenderer.renderMarkdown(
                    `<input type="checkbox"> ${dateRemoved}`,
                    taskText,
                    '',
                    this
                );
            }
            
            // Re-attach event listeners to the cloned checkbox
            const checkbox = clonedTask.querySelector('input[type="checkbox"]') as HTMLInputElement;
            if (checkbox) {
                checkbox.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const originalCheckbox = taskEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
                    if (originalCheckbox) {
                        originalCheckbox.click();
                    }
                });
            }
            
            container.appendChild(clonedTask);
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
        const hourHeight = 40;
        const top = start * hourHeight;
        const height = (end - start) * hourHeight;
        
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
            const taskKey = e.dataTransfer?.getData('text/plain');
            
            if (taskKey) {
                const timeBlock = this.timeBlocks.get(blockId);
                if (timeBlock && !timeBlock.tasks.includes(taskKey)) {
                    // Remove task from any other blocks
                    this.timeBlocks.forEach(block => {
                        block.tasks = block.tasks.filter(t => t !== taskKey);
                    });
                    
                    // Add task to this block
                    timeBlock.tasks.push(taskKey);
                    
                    // Clear and re-render tasks
                    element.empty();
                    timeBlock.tasks.forEach(key => this.renderTaskInBlock(key, element));
                    
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
    private setupTaskDragListeners(taskEl: HTMLElement, taskKey: string) {
        taskEl.setAttribute('draggable', 'true');
        taskEl.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', taskKey);
            taskEl.addClass('dragging');
        });

        taskEl.addEventListener('dragend', () => {
            taskEl.removeClass('dragging');
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