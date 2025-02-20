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
    private taskElements: Map<string, HTMLElement> = new Map();
    private taskCache: Map<string, TaskIdentity> = new Map();
    private fileCache: Map<string, string> = new Map();
    private debugEnabled: boolean = true;

    constructor(
        private app: App,
        private view: ITimelineView
    ) {}

    async createTaskElement(taskText: string, taskIdentity: TaskIdentity): Promise<HTMLElement | null> {
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
            .replace(/(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️|⏱️) .*?(?=(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️|⏱️)|$)/g, '')
            .trim();
        
        // Use Obsidian's markdown processor
        await MarkdownRenderer.renderMarkdown(
            taskMarkdown,
            textEl,
            '',
            this.view
        );

        // Add click handler for checkbox
        const checkbox = textEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (checkbox) {
            this.setupCheckboxHandler(checkbox, taskIdentity);
        }
        
        taskEl.appendChild(textEl);

        // Create controls container
        const controlsEl = document.createElement('div');
        controlsEl.addClass('task-controls');

        // Add stopwatch icon for time estimate
        const stopwatchEl = document.createElement('span');
        stopwatchEl.addClass('task-stopwatch');
        stopwatchEl.innerHTML = '⏱️';
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
        controlsEl.appendChild(stopwatchEl);

        // Add time estimate if available
        if (taskIdentity.metadata.timeEstimate) {
            const estimateEl = document.createElement('div');
            estimateEl.addClass('task-estimate');
            estimateEl.setText(`${this.formatTimeEstimate(taskIdentity.metadata.timeEstimate)}`);
            controlsEl.appendChild(estimateEl);
        }

        taskEl.appendChild(controlsEl);

        // Add drag listeners
        this.setupTaskDragListeners(taskEl, taskIdentity.identifier);

        // Store reference using identifier
        this.taskElements.set(taskIdentity.identifier, taskEl);

        return taskEl;
    }

    private setupCheckboxHandler(checkbox: HTMLInputElement, taskIdentity: TaskIdentity) {
        checkbox.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            const files = this.app.vault.getMarkdownFiles();
            this.debugLog('Searching through files for task');
            
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

    setupTaskDragListeners(taskEl: HTMLElement, identifier: string) {
        taskEl.setAttribute('draggable', 'true');
        taskEl.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', identifier);
            taskEl.addClass('dragging');
        });

        taskEl.addEventListener('dragend', () => {
            taskEl.removeClass('dragging');
        });
    }

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