import { App } from 'obsidian';
import type { ITimelineView } from './TimelineInterfaces';
import type { TimeBlock } from './TimeBlockManager';

export class TaskDragManager {
    constructor(private app: App, private view: ITimelineView) {}

    async handleTaskDrop(taskIdentifier: string, targetElement: HTMLElement, timeBlocks: Map<string, TimeBlock>, targetBlockId?: string, isUnscheduled: boolean = false)
    {
        const taskManager = this.view.getTaskManager();
        
        // Get current task identity from cache and ensure it has an ID if needed
        const currentTaskIdentity = targetBlockId ? 
                                    await taskManager.ensureTaskHasId(taskIdentifier) :
                                    taskManager.getTaskCache().get(taskIdentifier);
            
        if (!currentTaskIdentity) return;

        if (targetBlockId && timeBlocks.has(targetBlockId)) 
        {
            const timeBlock = timeBlocks.get(targetBlockId)!;

            // Only add if not already in this block
            if (!timeBlock.tasks.some(task => this.getTaskIdentifier(task) === taskIdentifier)) 
            {
                // Remove task from any other blocks
                timeBlocks.forEach(block => {
                    block.tasks = block.tasks.filter(task => 
                        this.getTaskIdentifier(task) !== taskIdentifier
                    );
                });

                // Add task to this block
                timeBlock.tasks.push(taskIdentifier);

                // Clear and re-render tasks
                targetElement.empty();
                for (const task of timeBlock.tasks) {
                    await this.renderTaskInBlock(this.getTaskIdentifier(task), targetElement);
                }
            }
        } 
        else if (isUnscheduled) 
        {
            // Remove task from all time blocks
            timeBlocks.forEach(block => {
                block.tasks = block.tasks.filter(task => 
                    this.getTaskIdentifier(task) !== taskIdentifier
                );
            });

            // Create new task element in unscheduled area
            const taskEl = await taskManager.createTaskElement(
                currentTaskIdentity.originalContent,
                currentTaskIdentity
            );
            if (taskEl) {
                targetElement.appendChild(taskEl);
            }
        }

        // Save time blocks if we modified them
        if (targetBlockId || isUnscheduled) {
            await this.view.getTimeBlockManager().saveTimeBlocks(this.view.getCurrentDayFile());
        }
    }

    private async renderTaskInBlock(taskIdentifier: string, container: HTMLElement) 
    {
        const taskManager = this.view.getTaskManager(); 
        const taskIdentity = taskManager.getTaskCache().get(taskIdentifier);
        if (!taskIdentity) 
        {
            // Try to find task by ID in files if not in cache
            const files = this.app.vault.getMarkdownFiles();
            for (const file of files) 
            {
                const content = await this.app.vault.read(file);
                const lines = content.split('\n');
                const taskLine = lines.find(line => 
                    line.includes(`🆔 ${taskIdentifier}`) || 
                    taskManager.getTaskIdentity(line).identifier === taskIdentifier);
                    
                if (taskLine) 
                {
                    taskManager.setTaskFilePath(taskIdentifier, file.path);
                    const newIdentity = taskManager.getTaskIdentity(taskLine);
                    const taskEl = await taskManager.createTaskElement(taskLine, newIdentity);
                    if (taskEl) {
                        container.appendChild(taskEl);
                    }
                    return;
                }
            }
            console.warn('Task not found in cache or files:', taskIdentifier);
            return;
        }

        const taskEl = await taskManager.createTaskElement(
            taskIdentity.originalContent,
            taskIdentity
        );
        if (taskEl) {
            container.appendChild(taskEl);
        }
    }

    private getTaskIdentifier(task: string | { id: string | null; text: string | null }): string {
        return typeof task === 'string' ? task : (task.id || task.text || '');
    }
} 