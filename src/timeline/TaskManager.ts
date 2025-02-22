import { MarkdownRenderer, TFile, App } from 'obsidian';
import { TaskParser, type TaskMetadata } from '../taskParser';
import type { ITimelineView } from './TimelineInterfaces';
import { moment } from 'obsidian';
import { TimeEstimateModal } from './TimeEstimateModal';

export interface TaskIdentity {
    identifier: string;  // Either plugin ID or content hash
    originalContent: string;
    metadata: TaskMetadata;
    filePath: string;  // Add file path tracking
}

export class TaskManager {
    private readonly taskElements: Map<string, HTMLElement> = new Map();
    private readonly taskCache: Map<string, TaskIdentity> = new Map();
    private readonly fileCache: Map<string, string> = new Map();

    constructor(
        private app: App,
        private view: ITimelineView
    ) {}

    public createTask(taskText: string, filePath: string): TaskIdentity 
    {
        const taskIdentity = this.getTaskIdentity(taskText);
        taskIdentity.filePath = filePath;
        this.taskCache.set(taskIdentity.identifier, taskIdentity);
        return taskIdentity;
    }

    public setupClonedTask(taskEl: HTMLElement, taskIdentity: TaskIdentity): HTMLElement 
    {
        const clonedTask = taskEl.cloneNode(true) as HTMLElement;
        this.setupTaskListeners(clonedTask, taskIdentity);
        return clonedTask;
    }
    
    public async processFile(file: TFile): Promise<void> {
        const content = await this.app.vault.read(file);
        this.fileCache.set(file.path, content);
        
        const previousTasksInFile = new Set(
            Array.from(this.taskCache.values())
                .filter(task => task.filePath === file.path)
                .map(task => task.identifier)
        );
        
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.match(/^- \[[ x]\]/)) {
                const taskIdentity = this.getTaskIdentity(line);
                taskIdentity.filePath = file.path;
                
                const existingTask = this.taskCache.get(taskIdentity.identifier);
                if (!existingTask || existingTask.originalContent !== taskIdentity.originalContent) {
                    this.taskCache.set(taskIdentity.identifier, taskIdentity);
                }
                previousTasksInFile.delete(taskIdentity.identifier);
            }
        }
        
        // Remove tasks that no longer exist in this file
        for (const taskId of previousTasksInFile) 
        {
            const task = this.taskCache.get(taskId);
            if (task && task.filePath === file.path)
            {
                this.removeTask(taskId);
            }
        }
    }
    
    private removeTask(taskId: string) 
    {
        this.taskCache.delete(taskId);
        const taskEl = this.taskElements.get(taskId);
        if (taskEl) {
            taskEl.remove();
            this.taskElements.delete(taskId);
        }
    }

    private setupTaskListeners(taskEl: HTMLElement, taskIdentity: TaskIdentity) {
        // Setup drag handle
        const dragHandle = taskEl.querySelector('.task-drag-handle');
        if (dragHandle) {
            this.setupTaskDragListeners(dragHandle as HTMLElement, taskIdentity.identifier, taskEl);
        }

        // Setup checkbox
        const checkbox = taskEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (checkbox) {
            this.setupCheckboxListeners(checkbox, taskIdentity);
        }

        // Setup time estimate button
        const stopwatchEl = taskEl.querySelector('.task-stopwatch');
        if (stopwatchEl) {
            this.setupTimeEstimateButtonListeners(stopwatchEl as HTMLElement, taskIdentity);
        }
    }

    async createTaskElement(taskText: string, taskIdentity: TaskIdentity): Promise<HTMLElement | null> {
        // Create task container
        const taskEl = document.createElement('div');
        taskEl.addClass('timeline-task');
        taskEl.setAttribute('data-task', taskIdentity.identifier);

        // Create drag handle
        const dragHandle = document.createElement('div');
        dragHandle.addClass('task-drag-handle');
        dragHandle.innerHTML = '⋮⋮'; // Vertical dots as drag indicator
        taskEl.appendChild(dragHandle);

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
            .replace(/(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️|⏱️) .*?(?=(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️|⏱️)|$)/g, '')
            .trim();
        
        // Use Obsidian's markdown processor
        await MarkdownRenderer.renderMarkdown(
            taskMarkdown,
            textEl,
            '',
            this.view
        );
        
        taskEl.appendChild(textEl);

        // Create controls container
        const controlsEl = document.createElement('div');
        controlsEl.addClass('task-controls');

        // Add stopwatch icon for time estimate
        const stopwatchEl = document.createElement('span');
        stopwatchEl.addClass('task-stopwatch');
        stopwatchEl.innerHTML = '⏱️';
        controlsEl.appendChild(stopwatchEl);

        // Add time estimate if available
        if (taskIdentity.metadata.timeEstimate) {
            const estimateEl = document.createElement('div');
            estimateEl.addClass('task-estimate');
            estimateEl.setText(`${this.formatTimeEstimate(taskIdentity.metadata.timeEstimate)}`);
            controlsEl.appendChild(estimateEl);
        }

        taskEl.appendChild(controlsEl);

        // Setup all listeners
        this.setupTaskListeners(taskEl, taskIdentity);

        // Store reference using identifier
        this.taskElements.set(taskIdentity.identifier, taskEl);

        return taskEl;
    }

    setupCheckboxListeners(checkbox: HTMLInputElement, taskIdentity: TaskIdentity) {
        checkbox.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            const files = this.app.vault.getMarkdownFiles();
            
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const lines = content.split('\n');
                const lineIndex = lines.findIndex(line => line.includes(taskIdentity.identifier));
                
                if (lineIndex !== -1) {
                    const originalLine = lines[lineIndex];
                    const isCurrentlyChecked = originalLine.includes('- [x]');
                    
                    const newContent = lines.map((line, index) => {
                        if (index === lineIndex) {
                            let newLine;
                            if (!isCurrentlyChecked) {
                                newLine = line.replace(/^-\s*\[\s*\]/, '- [x]') + 
                                       (line.includes('✅') ? '' : ` ✅ ${moment().format('YYYY-MM-DD')}`);
                            } else {
                                newLine = line.replace(/^-\s*\[x\]/, '- [ ]').replace(/✅\s*\d{4}-\d{2}-\d{2}/, '').trim();
                            }

                            checkbox.checked = !isCurrentlyChecked;
                            return newLine;
                        }
                        return line;
                    }).join('\n');
                    
                    await this.app.vault.modify(file, newContent);
                    break;
                }
            }
        });
    }

    setupTaskDragListeners(dragHandle: HTMLElement, identifier: string, taskEl: HTMLElement) {
        dragHandle.setAttribute('draggable', 'true');
        dragHandle.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', identifier);
            taskEl.addClass('dragging');
        });

        dragHandle.addEventListener('dragend', () => {
            taskEl.removeClass('dragging');
        });
    }

    setupTimeEstimateButtonListeners(stopwatchEl: HTMLElement, taskIdentity: TaskIdentity) {
        stopwatchEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            const modal = new TimeEstimateModal(this.app);
            const result = await modal.openAndGetValue();
            
            if (result) {
                let newContent = taskIdentity.originalContent;
                
                // Remove existing time estimate if present
                newContent = newContent.replace(/⏱️\s*(?:\d+d)?\s*(?:\d+h)?\s*(?:\d+m)?\s*/, '');
                
                // Add new time estimate before any other metadata
                const metadataMatch = newContent.match(/(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️)/);
                if (metadataMatch) {
                    const index = metadataMatch.index!;
                    newContent = newContent.slice(0, index) + result + ' ' + newContent.slice(index);
                } else {
                    newContent = newContent.trim() + ' ' + result;
                }
                
                // Update task in file and cache
                await this.updateTaskInFile(taskIdentity.originalContent, newContent, taskIdentity.filePath);
                const newIdentity = this.getTaskIdentity(newContent);
                newIdentity.filePath = taskIdentity.filePath;
                this.taskCache.set(newIdentity.identifier, newIdentity);
                
                // Re-render all instances of this task
                const taskElements = Array.from(document.querySelectorAll(`[data-task="${taskIdentity.identifier}"]`));
                for (const element of taskElements) {
                    const newTaskEl = await this.createTaskElement(newContent, newIdentity);
                    if (newTaskEl && element.parentElement) {
                        element.parentElement.replaceChild(newTaskEl, element);
                    }
                }

                // Trigger a refresh of any time blocks containing this task
                await this.view.refreshView();
            }
        });
    }

    // TODO: This should not be needed as a public method, and private version should be renamed to something like "generateTaskIdentity"
    getTaskIdentity(taskText: string): TaskIdentity {
        const metadata = TaskParser.parseTask(taskText, this.view.getPlugin().settings);
        
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

    async addIdToTask(taskText: string): Promise<string> {
        if (taskText.includes('🆔')) {
            return taskText; // Already has an ID
        }

        const id = this.generateTaskId();
        return taskText.trim() + ` 🆔 ${id}`;
    }

    async updateTaskInFile(originalTask: string, newTask: string, filePath: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const content = await this.app.vault.read(file);
            const newContent = content.replace(originalTask, newTask);
            await this.app.vault.modify(file, newContent);
        }
    }

    private formatTimeEstimate(estimate: { days: number, hours: number, minutes: number }): string {
        const parts = [];
        if (estimate.days > 0) parts.push(`${estimate.days}d`);
        if (estimate.hours > 0) parts.push(`${estimate.hours}h`);
        if (estimate.minutes > 0) parts.push(`${estimate.minutes}m`);
        return parts.join(' ');
    }

    clearCaches() {
        this.taskCache.clear();
        this.fileCache.clear();
    }

    getTaskCache() {
        return this.taskCache;
    }

    getFileCache() {
        return this.fileCache;
    }

    getTaskElements() {
        return this.taskElements;
    }
}