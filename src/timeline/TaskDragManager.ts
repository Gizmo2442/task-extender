import { App } from 'obsidian';
import type { ITimelineView } from './TimelineInterfaces';
import type { TimeBlock } from './TimeBlockManager';
import type { TaskIdentity } from './TaskManager';

export class TaskDragManager {
    constructor(private app: App, private view: ITimelineView) {}

    async handleTaskDrop(taskIdentifier: string, targetElement: HTMLElement, timeBlocks: Map<string, TimeBlock>, targetBlockId?: string, isUnscheduled: boolean = false)
    {
        const taskManager = this.view.getTaskManager();
        
        // Get current task identity from cache
        let currentTaskIdentity = taskManager.getTask(taskIdentifier);
        
        if (!currentTaskIdentity) {
            console.warn('Task not found in cache:', taskIdentifier);
            return;
        }

        if (targetBlockId) 
        {
            const targetBlock = timeBlocks.get(targetBlockId);
            if (!targetBlock) return;

            // Remove task from all other blocks
            timeBlocks.forEach(block => {
                if (block.id !== targetBlockId) {
                    block.tasks = block.tasks.filter(taskIdentity => 
                        taskIdentity.identifier !== currentTaskIdentity!.identifier
                    );
                }
            });

            // Add task to target block if not already present
            if (!targetBlock.tasks.some(taskIdentity => taskIdentity.identifier === currentTaskIdentity!.identifier)) {
                targetBlock.tasks.push(currentTaskIdentity);

                // Create new task element
                const taskEl = await taskManager.createTaskElement(
                    currentTaskIdentity.originalContent,
                    currentTaskIdentity
                );
                if (taskEl) {
                    targetElement.appendChild(taskEl);
                }
            }
        }
        else if (isUnscheduled) 
        {
            // Remove task from all time blocks
            timeBlocks.forEach(block => {
                block.tasks = block.tasks.filter(taskIdentity => 
                    taskIdentity.identifier !== currentTaskIdentity!.identifier
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
} 