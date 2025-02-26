import { MarkdownRenderer, TFile, App } from 'obsidian';
import { TaskParser, type TaskMetadata } from '../TaskParser';
import type { ITimelineView } from './TimelineInterfaces';
import { moment } from 'obsidian';
import { TimeEstimateModal } from './TimeEstimateModal';

export interface TaskIdentity {
    identifier: string;  // Hash of originalContent + filePath + lineNumber
    originalContent: string;
    metadata: TaskMetadata;
    filePath: string;  // File path tracking
    lineNumber: number; // Line number in file
}

export class TaskManager {
    private readonly taskElements: Map<string, HTMLElement> = new Map();
    private readonly taskCache: Map<string, TaskIdentity> = new Map();
    private readonly fileCache: Map<string, string> = new Map();
    private readonly lineTaskMap: Map<string, string> = new Map(); // Maps filePath:lineNumber to taskId

    // Define a constant for the emoji metadata pattern to ensure consistency
    private readonly METADATA_EMOJI_PATTERN = /(?:📅|✅|🆔|📝|⏫|🔼|🔽|⏬|📌|⚡|➕|⏳|📤|📥|💤|❗|❌|✔️|⏰|🔁|🔂|🛫|🛬|📍|🕐|🔍|🎯|🎫|💯|👥|👤|📋|✍️|👉|👈|⚠️|⏱️)/g;

    constructor(
        private app: App,
        private view: ITimelineView
    ) {}
    
    /////////////////////////////////////////
    // Public methods
    /////////////////////////////////////////

    public getTask(identifier: string): TaskIdentity | undefined {
        return this.taskCache.get(identifier);
    }

    public findTaskByContent(taskText: string): TaskIdentity | undefined {
        // Strip metadata from the search text
        const strippedContent = this.stripTaskMetadata(taskText);
        
        // Search through all tasks in the cache
        for (const task of this.taskCache.values()) {
            const taskContent = this.stripTaskMetadata(task.originalContent);
            if (this.areTasksSimilar(strippedContent, taskContent)) {
                return task;
            }
        }
        
        return undefined;
    }

    public createTask(taskText: string, filePath: string, lineNumber: number): TaskIdentity {
        const existingTask = this.findMatchingTask(taskText, filePath, lineNumber);
        if (existingTask) {
            this.updateTaskContent(existingTask.identifier, taskText, filePath, lineNumber);
            return existingTask;
        }

        const taskIdentity = this.generateTaskIdentity(taskText, filePath, lineNumber);
        this.taskCache.set(taskIdentity.identifier, taskIdentity);
        this.lineTaskMap.set(`${filePath}:${lineNumber}`, taskIdentity.identifier);
        return taskIdentity;
    }

    public async processFile(file: TFile, today: string) {
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
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            if (line.match(/^- \[[ x]\]/)) {
                const taskIdentity = this.createTask(line, file.path, lineIndex + 1);
                
                if (taskIdentity.metadata.dueDate && 
                    moment(taskIdentity.metadata.dueDate).format('YYYY-MM-DD') === today) {
                    await this.createTaskElement(line, taskIdentity);
                }
                previousTasksInFile.delete(taskIdentity.identifier);
            }
        }
        
        // Remove tasks that no longer exist in this file
        for (const taskId of previousTasksInFile) {
            const task = this.taskCache.get(taskId);
            if (task && task.filePath === file.path) {
                this.removeTask(taskId);
            }
        }
    }

    public async createTaskElement(taskText: string, taskIdentity: TaskIdentity): Promise<HTMLElement | null> 
    {
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
        
        // Find current task status by checking the TaskIdentity's file and line number
        let currentTaskStatus = false;
        const file = this.app.vault.getAbstractFileByPath(taskIdentity.filePath);
        if (file instanceof TFile) 
        {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            const taskLine = lines[taskIdentity.lineNumber - 1]; // Convert to zero-based index
            if (taskLine && taskLine.includes(taskIdentity.originalContent))
                currentTaskStatus = taskLine.includes('- [x]');
            else
                console.error(`Task mismatch error: The task on the specified line does not match the expected task content. Expected: "${taskIdentity.originalContent}", Found: "${taskLine}" at line number ${taskIdentity.lineNumber} in file ${taskIdentity.filePath}`);
        }
        
        // Use Obsidian's markdown renderer for the checkbox
        const taskMarkdown = this.createTaskMarkdown(taskText, currentTaskStatus);
        
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

    public getTaskIdentity(taskText: string, filePath: string = '', lineNumber: number = 0): TaskIdentity {
        const metadata = TaskParser.parseTask(taskText, this.view.getPlugin().settings);
        
        // Get the core task content without checkbox and metadata
        const baseContent = taskText
            .replace(/^- \[[ x]\] /, '')  // Remove checkbox
            .replace(new RegExp(`${this.METADATA_EMOJI_PATTERN.source} .*?(?=${this.METADATA_EMOJI_PATTERN.source}|$)`, 'g'), '')  // Remove metadata
            .trim();

        // Generate a hash from the task content, file path, and line number
        const hashInput = `${baseContent}|${filePath}|${lineNumber}`;
        const hash = this.generateHash(hashInput);

        return {
            identifier: hash,
            originalContent: taskText,
            metadata,
            filePath,
            lineNumber
        };
    }

    public async updateTaskInFile(originalTask: string, newTask: string, filePath: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const content = await this.app.vault.read(file);
            const newContent = content.replace(originalTask, newTask);
            await this.app.vault.modify(file, newContent);
        }
    }

    public clearCaches() {
        this.taskCache.clear();
        this.fileCache.clear();
    }

    public getTaskCache() {
        return this.taskCache;
    }

    public getFileCache() {
        return this.fileCache;
    }

    public getTaskElements() {
        return this.taskElements;
    }

    public setTaskFilePath(taskIdentifier: string, filePath: string): void
    {
        const taskIdentity = this.taskCache.get(taskIdentifier);
        if (!taskIdentity || taskIdentity.filePath === filePath) return;

        taskIdentity.filePath = filePath;
        this.taskCache.set(taskIdentifier, taskIdentity);
    }

    public setupClonedTask(taskEl: HTMLElement, taskIdentity: TaskIdentity): HTMLElement {
        const clonedTask = taskEl.cloneNode(true) as HTMLElement;
        this.setupTaskListeners(clonedTask, taskIdentity);
        return clonedTask;
    }
    
    /////////////////////////////////////////
    // Private methods
    /////////////////////////////////////////
    
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

    private formatTimeEstimate(estimate: { days: number, hours: number, minutes: number }): string {
        const parts = [];
        if (estimate.days > 0) parts.push(`${estimate.days}d`);
        if (estimate.hours > 0) parts.push(`${estimate.hours}h`);
        if (estimate.minutes > 0) parts.push(`${estimate.minutes}m`);
        return parts.join(' ');
    }

    private async addIdToTask(taskText: string): Promise<string> {
        if (taskText.includes('🆔')) {
            return taskText; // Already has an ID
        }

        const id = this.generateHash(taskText);
        return taskText.trim() + ` 🆔 ${id}`;
    }
    

    private generateTaskIdentity(taskText: string, filePath: string, lineNumber: number): TaskIdentity {
        const baseContent = this.stripTaskMetadata(taskText);
        const hashInput = `${baseContent}|${filePath}`;
        const hash = this.generateHash(hashInput);

        return {
            identifier: hash,
            originalContent: taskText,
            metadata: TaskParser.parseTask(taskText, this.view.getPlugin().settings),
            filePath,
            lineNumber: lineNumber
        };
    }

    private stripTaskMetadata(taskText: string): string {
        return taskText
            .replace(/^- \[[ x]\] /, '')  // Remove checkbox
            .replace(new RegExp(`${this.METADATA_EMOJI_PATTERN.source} .*?(?=${this.METADATA_EMOJI_PATTERN.source}|$)`, 'g'), '')  // Remove metadata
            .trim();
    }

    private createTaskMarkdown(taskText: string, isChecked: boolean): string {
        return taskText
            .replace(/^- \[([ x])\]/, () => {
                return `<input type="checkbox" ${isChecked ? 'checked' : ''}>`;
            })
            // Strip all metadata emojis and their content
            .replace(new RegExp(`${this.METADATA_EMOJI_PATTERN.source} .*?(?=${this.METADATA_EMOJI_PATTERN.source}|$)`, 'g'), '')
            .trim();
    }

    private findMatchingTask(taskText: string, filePath: string, lineNumber: number): TaskIdentity | undefined {
        const strippedContent = this.stripTaskMetadata(taskText);
        
        // Case 1: Check if we have a task at this exact line
        const existingTaskId = this.lineTaskMap.get(`${filePath}:${lineNumber}`);
        if (existingTaskId) {
            const existingTask = this.taskCache.get(existingTaskId);
            if (existingTask && this.areTasksSimilar(strippedContent, this.stripTaskMetadata(existingTask.originalContent))) {
                return existingTask;
            }
        }

        // Case 2: Look for similar tasks in the same file
        const tasksInFile = Array.from(this.taskCache.values())
            .filter(task => task.filePath === filePath);
        
        for (const task of tasksInFile) {
            if (this.areTasksSimilar(strippedContent, this.stripTaskMetadata(task.originalContent))) {
                return task;
            }
        }

        // Case 3: Look for similar tasks that have been removed from other files
        const removedTasks = Array.from(this.taskCache.values())
            .filter(task => {
                const content = this.fileCache.get(task.filePath);
                return !content?.includes(task.originalContent);
            });

        for (const task of removedTasks) {
            if (this.areTasksSimilar(strippedContent, this.stripTaskMetadata(task.originalContent))) {
                return task;
            }
        }

        return undefined;
    }

    private areTasksSimilar(text1: string, text2: string): boolean {
        // Simple Levenshtein distance with a threshold
        const maxDistance = Math.min(Math.floor(Math.max(text1.length, text2.length) * 0.2), 7); // Allow 20% difference with an upper bound of 7
        return this.levenshteinDistance(text1, text2) <= maxDistance;
    }

    private levenshteinDistance(str1: string, str2: string): number {
        const m = str1.length;
        const n = str2.length;
        const dp: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (str1[i - 1] === str2[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = 1 + Math.min(
                        dp[i - 1][j],     // deletion
                        dp[i][j - 1],     // insertion
                        dp[i - 1][j - 1]  // substitution
                    );
                }
            }
        }

        return dp[m][n];
    }

    private updateTaskContent(identifier: string, newContent: string, filePath: string, lineNumber: number): void {
        const task = this.taskCache.get(identifier);
        if (task) {
            // Remove old line mapping
            if (task.filePath && task.lineNumber) {
                this.lineTaskMap.delete(`${task.filePath}:${task.lineNumber}`);
            }

            // Update task
            task.originalContent = newContent;
            task.metadata = TaskParser.parseTask(newContent, this.view.getPlugin().settings);
            task.filePath = filePath;
            task.lineNumber = lineNumber;

            // Add new line mapping
            this.lineTaskMap.set(`${filePath}:${lineNumber}`, identifier);
        }
    }

    private generateHash(input: string): string {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const char = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return 'task_' + Math.abs(hash).toString(36);
    }

    private setupCheckboxListeners(checkbox: HTMLInputElement, taskIdentity: TaskIdentity) 
    {
        checkbox.addEventListener('click', async (e) => 
        {
            e.stopPropagation();
            e.preventDefault();

            const file = this.app.vault.getAbstractFileByPath(taskIdentity.filePath);
            if (file instanceof TFile) 
            {
                const content = await this.app.vault.read(file);
                const lines = content.split('\n');
                const lineIndex = taskIdentity.lineNumber - 1; // Convert to zero-based index

                if (lines[lineIndex] && lines[lineIndex].includes(taskIdentity.originalContent)) 
                {
                    const originalLine = lines[lineIndex];
                    const isCurrentlyChecked = originalLine.includes('- [x]');

                    const newLine = isCurrentlyChecked
                        ? originalLine.replace(/^-\s*\[x\]/, '- [ ]').replace(/✅\s*\d{4}-\d{2}-\d{2}/, '').trim()
                        : originalLine.replace(/^-\s*\[\s*\]/, '- [x]') + 
                          (originalLine.includes('✅') ? '' : ` ✅ ${moment().format('YYYY-MM-DD')}`);

                    lines[lineIndex] = newLine;
                    checkbox.checked = !isCurrentlyChecked;

                    const newContent = lines.join('\n');
                    await this.app.vault.modify(file, newContent);
                } 
                else 
                {
                    console.error('Task mismatch error: The task on the specified line does not match the expected task content.');
                }
            }
        });
    }

    private setupTaskDragListeners(dragHandle: HTMLElement, identifier: string, taskEl: HTMLElement) {
        dragHandle.setAttribute('draggable', 'true');
        dragHandle.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', identifier);
            taskEl.addClass('dragging');
        });

        dragHandle.addEventListener('dragend', () => {
            taskEl.removeClass('dragging');
        });
    }

    private setupTimeEstimateButtonListeners(stopwatchEl: HTMLElement, taskIdentity: TaskIdentity) {
        stopwatchEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            const modal = new TimeEstimateModal(this.app);
            const result = await modal.openAndGetValue();
            
            if (result) {
                let newContent = taskIdentity.originalContent;
                
                // Remove existing time estimate if present
                newContent = newContent.replace(/⏱️\s*(?:\d+d)?\s*(?:\d+h)?\s*(?:\d+m)?\s*/, '');
                
                // Add new time estimate before any other metadata
                const metadataMatch = newContent.match(this.METADATA_EMOJI_PATTERN);
                if (metadataMatch) {
                    const index = metadataMatch.index!;
                    newContent = newContent.slice(0, index) + result + ' ' + newContent.slice(index);
                } else {
                    newContent = newContent.trim() + ' ' + result;
                }
                
                // Update task in file and cache
                await this.updateTaskInFile(taskIdentity.originalContent, newContent, taskIdentity.filePath);
                this.updateTaskContent(taskIdentity.identifier, newContent, taskIdentity.filePath, taskIdentity.lineNumber);
                
                // Re-render all instances of this task
                const taskElements = Array.from(document.querySelectorAll(`[data-task="${taskIdentity.identifier}"]`));
                for (const element of taskElements) {
                    const newTaskEl = await this.createTaskElement(newContent, taskIdentity);
                    if (newTaskEl && element.parentElement) {
                        element.parentElement.replaceChild(newTaskEl, element);
                    }
                }

                // Trigger a refresh of any time blocks containing this task
                await this.view.refreshView();
            }
        });
    }
}