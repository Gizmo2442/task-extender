import { App, TFile } from 'obsidian';
import type { ITimelineView } from './TimelineInterfaces';
import type { TaskIdentity } from './TaskManager';

export interface TimeBlock {
    id: string;
    title: string;
    startTime: number;  // Decimal hour (e.g., 9.25 for 9:15)
    endTime: number;    // Decimal hour (e.g., 10.5 for 10:30)
    tasks: TaskIdentity[];
}

// Task status for visual indication
export enum TaskStatus {
    NORMAL = 'normal',
    FOUND_BY_CONTENT = 'found-by-content',
    NOT_FOUND = 'not-found'
}

// Extended TaskIdentity with status
export interface TimeBlockTaskIdentity extends TaskIdentity {
    status?: TaskStatus;
}

export class TimeBlockManager {
    private timeBlocks: Map<string, TimeBlock> = new Map();
    private debugEnabled: boolean = true;

    constructor(
        private app: App,
        private view: ITimelineView,
        private hourHeight: number
    ) {}

    async loadTimeBlocks(currentDayFile: TFile | null) 
    {
        if (!currentDayFile) return;
        
        const content = await this.app.vault.read(currentDayFile);
        const match = content.match(/```timeBlocks\n([\s\S]*?)\n```/);
        
        if (match) 
        {
            try 
            {
                const timeBlocksData = JSON.parse(match[1]);
                
                // Process each block and its tasks
                for (const [blockId, blockData] of Object.entries(timeBlocksData)) 
                {
                    const block = blockData as TimeBlock;
                    const processedTasks: TimeBlockTaskIdentity[] = [];
                    
                    // Process each task in the block
                    for (const taskData of block.tasks) 
                    {
                        const { id, text } = taskData as any;
                        
                        // Try to get the task directly from the task manager by ID
                        if (id) {
                            const taskIdentity = this.view.getTaskManager().getTask(id);
                            if (taskIdentity) {
                                // Found by ID - normal status
                                processedTasks.push({
                                    ...taskIdentity,
                                    status: TaskStatus.NORMAL
                                });
                                continue;
                            }
                        }
                        
                        // Fallback: If task not found by ID but we have text, try to find by content
                        if (text) {
                            const matchingTasks = this.view.getTaskManager().findTasksByContent(text);
                            if (matchingTasks.length > 0) {
                                // Found by content - yellow status
                                processedTasks.push({
                                    ...matchingTasks[0],
                                    status: TaskStatus.FOUND_BY_CONTENT
                                });
                                continue;
                            }
                        }
                        
                        // If we get here, the task wasn't found - create a placeholder task
                        const taskContent = text || `Task with ID: ${id}`;
                        const placeholderTask: TimeBlockTaskIdentity = {
                            identifier: id || `placeholder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                            originalContent: `- [ ] ${taskContent}`,
                            metadata: { timeEstimate: { days: 0, hours: 0, minutes: 0, totalMinutes: 0 } },
                            filePath: '',
                            lineNumber: 0,
                            status: TaskStatus.NOT_FOUND
                        };
                        
                        processedTasks.push(placeholderTask);
                        
                        if (this.debugEnabled) {
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
                    this.renderTimeBlock(block, this.view.getTimelineEl());
                });
            } catch (e) {
                console.error('Failed to parse time blocks:', e);
            }
        }
    }

    async saveTimeBlocks(currentDayFile: TFile | null) 
    {
        if (!currentDayFile) return;
        
        // Helper function to process tasks for saving
        const saveTimeBlocks_processTimeBlock = (blockId: string, block: TimeBlock): [string, any] => {
            const tasksWithInfo = block.tasks.map(taskIdentity => ({
                id: this.getTaskIdentifier(taskIdentity),
                text: taskIdentity.originalContent.replace(/^- \[[ x]\] /, '').trim()
            }));
            return [blockId, { ...block, tasks: tasksWithInfo }];
        };

        const content = await this.app.vault.read(currentDayFile);
        
        // Convert timeBlocks to a format that includes both ID and text for each task
        const timeBlocksData = Object.fromEntries(
            Array.from(this.timeBlocks.entries()).map(([blockId, block]) => 
                saveTimeBlocks_processTimeBlock(blockId, block)
            )
        );

        const timeBlocksJson = JSON.stringify(timeBlocksData, null, 2);

        if (content.includes('```timeBlocks')) {
            const newContent = content.replace(
                /```timeBlocks\n[\s\S]*?\n```/,
                '```timeBlocks\n' + timeBlocksJson + '\n```'
            );
            await this.app.vault.modify(currentDayFile, newContent);
        } else {
            await this.app.vault.modify(
                currentDayFile,
                content + '\n\n```timeBlocks\n' + timeBlocksJson + '\n```'
            );
        }
    }

    renderTimeBlock(block: TimeBlock, parent: DocumentFragment | HTMLElement) {
        // Remove existing block if it exists
        const existingBlock = parent.querySelector(`[data-block-id="${block.id}"]`);
        if (existingBlock) {
            existingBlock.remove();
        }

        const blockEl = document.createElement('div');
        blockEl.addClass('time-block');
        blockEl.setAttribute('data-block-id', block.id);
        
        const top = block.startTime * this.hourHeight;
        const height = (block.endTime - block.startTime) * this.hourHeight;
        
        blockEl.style.top = `${top}px`;
        blockEl.style.height = `${height}px`;
        
        // Calculate and display percentage
        const { percentage, totalMinutes } = this.calculateBlockPercentage(block);
        const titleContainer = blockEl.createEl('div', { cls: 'time-block-header' });
        
        const titleEl = titleContainer.createEl('div', { 
            cls: 'time-block-title',
            text: block.title
        });

        const percentageEl = titleContainer.createEl('div', {
            cls: 'time-block-percentage',
            text: `${Math.round(percentage)}%`
        });
        
        percentageEl.style.color = this.getPercentageColor(percentage);
        if (percentage > 100) {
            percentageEl.style.fontWeight = 'bold';
        }

        // Add resize handles
        const topHandle = blockEl.createEl('div', { cls: 'time-block-handle top-handle' });
        const bottomHandle = blockEl.createEl('div', { cls: 'time-block-handle bottom-handle' });

        // Setup drag handlers for the block
        this.setupBlockDragHandlers(blockEl, block.id);
        
        // Setup resize handlers
        this.setupBlockResizeHandlers(blockEl, block.id, topHandle, bottomHandle);

        this.setupBlockDropZone(blockEl, block.id);

        block.tasks.forEach(taskIdentity => {
            this.renderTaskInBlock(taskIdentity, blockEl);
        });

        parent.appendChild(blockEl);
    }

    public updateHourHeight(newHeight: number) {
        this.hourHeight = newHeight;
        // Re-render all blocks with new height
        this.timeBlocks.forEach(block => {
            this.renderTimeBlock(block, this.view.getTimelineEl());
        });
    }

    private calculateBlockPercentage(block: TimeBlock): { percentage: number, totalMinutes: number } {
        let totalTaskMinutes = 0;
        const blockDurationMinutes = (block.endTime - block.startTime) * 60;

        block.tasks.forEach(taskIdentity => {
            if (taskIdentity?.metadata.timeEstimate) {
                totalTaskMinutes += taskIdentity.metadata.timeEstimate.totalMinutes;
            }
        });

        return {
            percentage: (totalTaskMinutes / blockDurationMinutes) * 100,
            totalMinutes: totalTaskMinutes
        };
    }

    private getPercentageColor(percentage: number): string {
        if (percentage <= 50) return 'var(--color-green)';
        if (percentage <= 75) return 'var(--color-yellow)';
        if (percentage <= 90) return 'var(--color-orange)';
        return 'var(--color-red)';
    }

    private async renderTaskInBlock(taskIdentity: TimeBlockTaskIdentity, container: HTMLElement) 
    {
        // First get the latest task content from cache
        const taskIdentityFromCache = this.view.getTaskManager().getTask(taskIdentity.identifier) as TimeBlockTaskIdentity;
        
        // A bit unsure if this block is needed
        if (!taskIdentityFromCache) 
        {
            // Check if this is a placeholder task in any of the time blocks
            let foundPlaceholder = false;
            this.timeBlocks.forEach(block => 
            {
                const placeholderTask = block.tasks.find(t => 
                    t.identifier === taskIdentity.identifier && (t as TimeBlockTaskIdentity).status === TaskStatus.NOT_FOUND
                );
                if (placeholderTask) {
                    foundPlaceholder = true;
                    this.renderPlaceholderTask(placeholderTask as TimeBlockTaskIdentity, container);
                }
            });
            
            if (!foundPlaceholder)
                console.warn('Task not found in cache or files:', taskIdentity.identifier);

            return;
        }

        // Create a new task element with the latest content
        const taskEl = await this.view.getTaskManager().createTaskElement(taskIdentity.originalContent, taskIdentity);
        if (taskEl) 
        {
            // Apply styling based on task status
            if (taskIdentity.status === TaskStatus.FOUND_BY_CONTENT) {
                taskEl.addClass('task-found-by-content');
                
                // Find similar tasks count
                const similarTasks = this.view.getTaskManager().findTasksByContent(taskIdentity.originalContent);
                
                // Create counter element
                const counterEl = document.createElement('div');
                counterEl.addClass('task-similar-counter');
                counterEl.innerHTML = `(${similarTasks.length})`;
                
                // Create fix button
                const fixButton = document.createElement('button');
                fixButton.addClass('task-fix-button');
                fixButton.innerHTML = 'Fix';
                fixButton.title = 'Select the correct task from similar matches';
                
                // Add event listener to fix button
                fixButton.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    
                    // Find the block ID
                    const blockEl = container.closest('.time-block');
                    if (blockEl) {
                        const blockId = blockEl.getAttribute('data-block-id');
                        if (blockId) {
                            // Show similar tasks modal
                            await this.showSimilarTasksModal(taskIdentity, blockId);
                        }
                    }
                });
                
                // Find where to insert the counter and fix button
                const textEl = taskEl.querySelector('.task-text');
                if (textEl) {
                    // Create a container for counter and fix button
                    const contentFixContainer = document.createElement('div');
                    contentFixContainer.addClass('content-fix-container');
                    contentFixContainer.style.display = 'flex';
                    contentFixContainer.style.alignItems = 'center';
                    contentFixContainer.style.marginLeft = '8px';
                    
                    contentFixContainer.appendChild(counterEl);
                    contentFixContainer.appendChild(fixButton);
                    
                    textEl.appendChild(contentFixContainer);
                }
            } else if (taskIdentity.status === TaskStatus.NOT_FOUND) {
                taskEl.addClass('task-not-found');
            }
            
            container.appendChild(taskEl);
        }
    }
    
    private async renderPlaceholderTask(placeholderTask: TimeBlockTaskIdentity, container: HTMLElement) {
        // Create a simple placeholder element
        const taskEl = document.createElement('div');
        taskEl.addClass('timeline-task', 'task-not-found');
        taskEl.setAttribute('data-task', placeholderTask.identifier);
        
        // Create task text container
        const textEl = document.createElement('div');
        textEl.addClass('task-text');
        textEl.innerHTML = `<strong>${placeholderTask.originalContent.replace(/^- \[[ x]\] /, '')}</strong>`;
        
        taskEl.appendChild(textEl);
        container.appendChild(taskEl);
    }

    private setupBlockDragHandlers(blockEl: HTMLElement, blockId: string) {
        let isDragging = false;
        let startY = 0;
        let startTop = 0;
        let originalBlock: TimeBlock;

        blockEl.addEventListener('mousedown', (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target === blockEl || 
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
            
            // Convert pixel position to decimal hours
            const newStartTime = Math.round((newTop / this.hourHeight) * 4) / 4;
            const duration = originalBlock.endTime - originalBlock.startTime;
            
            // Ensure block stays within timeline bounds
            if (newStartTime >= 0 && newStartTime + duration <= 24) {
                blockEl.style.top = `${newStartTime * this.hourHeight}px`;
                
                // Update block times
                const block = this.timeBlocks.get(blockId)!;
                block.startTime = newStartTime;
                block.endTime = newStartTime + duration;
            }
        });

        document.addEventListener('mouseup', async () => {
            if (isDragging) {
                isDragging = false;
                blockEl.removeClass('dragging');
                await this.saveTimeBlocks(this.view.getCurrentDayFile());
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
                const newStartTime = Math.round((newTop / this.hourHeight) * 4) / 4;
                
                if (newStartTime >= 0 && newStartTime < block.endTime) {
                    blockEl.style.top = `${newStartTime * this.hourHeight}px`;
                    blockEl.style.height = `${(block.endTime - newStartTime) * this.hourHeight}px`;
                    block.startTime = newStartTime;
                }
            } else {
                const newHeight = startHeight + deltaY;
                const newEndTime = Math.round(((startTop + newHeight) / this.hourHeight) * 4) / 4;
                
                if (newEndTime <= 24 && newEndTime > block.startTime) {
                    blockEl.style.height = `${(newEndTime - block.startTime) * this.hourHeight}px`;
                    block.endTime = newEndTime;
                }
            }
        });

        document.addEventListener('mouseup', async () => {
            if (isResizing) {
                isResizing = false;
                blockEl.removeClass('resizing');
                await this.saveTimeBlocks(this.view.getCurrentDayFile());
            }
        });
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
            
            await this.view.getTaskDragManager().handleTaskDrop(
                rawIdentifier,
                element,
                this.timeBlocks,
                blockId
            );
        });
    }

    getTimeBlocks() {
        return this.timeBlocks;
    }
    
    private async showSimilarTasksModal(taskIdentity: TaskIdentity, blockId: string): Promise<void> {
        // Find similar tasks
        const similarTasks = this.view.getTaskManager().findTasksByContent(taskIdentity.originalContent);
        
        // Create a modal
        const modal = document.createElement('div');
        modal.addClass('modal');
        
        const modalContent = document.createElement('div');
        modalContent.addClass('modal-content');
        modalContent.style.width = '500px';
        modalContent.style.maxHeight = '80vh';
        
        const modalHeader = document.createElement('div');
        modalHeader.addClass('modal-header');
        modalHeader.innerHTML = '<h3>Select the correct task</h3>';
        modalContent.appendChild(modalHeader);
        
        const modalDescription = document.createElement('div');
        modalDescription.addClass('modal-description');
        modalDescription.innerHTML = `<p>Found ${similarTasks.length} similar tasks. Select the correct task to use in this time block:</p>`;
        modalContent.appendChild(modalDescription);
        
        const taskList = document.createElement('div');
        taskList.addClass('similar-tasks-list');
        taskList.style.maxHeight = '60vh';
        taskList.style.overflowY = 'auto';
        
        // Add each similar task to the list
        for (const task of similarTasks) {
            const taskItem = document.createElement('div');
            taskItem.addClass('similar-task-item');
            taskItem.style.padding = '8px';
            taskItem.style.margin = '4px 0';
            taskItem.style.border = '1px solid var(--background-modifier-border)';
            taskItem.style.borderRadius = '4px';
            taskItem.style.cursor = 'pointer';
            
            const taskContent = document.createElement('div');
            taskContent.addClass('task-content');
            
            // Show the task content
            const contentText = document.createElement('p');
            contentText.innerHTML = task.originalContent.replace(/^- \[[ x]\] /, '');
            taskContent.appendChild(contentText);
            
            // Show the file path
            const filePath = document.createElement('div');
            filePath.addClass('task-filepath');
            filePath.style.fontSize = '0.8em';
            filePath.style.color = 'var(--text-muted)';
            filePath.innerHTML = `<em>File: ${task.filePath}</em>`;
            taskContent.appendChild(filePath);
            
            taskItem.appendChild(taskContent);
            
            // Add click handler to select this task
            taskItem.addEventListener('click', async () => {
                // Update the time block to use this task's ID
                await this.updateTimeBlockTask(taskIdentity.identifier, task.identifier, blockId);
                
                // Close the modal
                document.body.removeChild(modal);
            });
            
            taskList.appendChild(taskItem);
        }
        
        modalContent.appendChild(taskList);
        
        // Add a cancel button
        const cancelButton = document.createElement('button');
        cancelButton.addClass('mod-warning');
        cancelButton.style.marginTop = '16px';
        cancelButton.innerText = 'Cancel';
        cancelButton.addEventListener('click', () => {
            document.body.removeChild(modal);
        });
        modalContent.appendChild(cancelButton);
        
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
        
        // Position modal in center
        modalContent.style.position = 'fixed';
        modalContent.style.top = '50%';
        modalContent.style.left = '50%';
        modalContent.style.transform = 'translate(-50%, -50%)';
        modalContent.style.zIndex = '1000';
        modalContent.style.backgroundColor = 'var(--background-primary)';
        modalContent.style.padding = '20px';
        modalContent.style.borderRadius = '8px';
        modalContent.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.2)';
    }

    public async updateTimeBlockTask(oldTaskId: string, newTaskId: string, blockId: string): Promise<void> {
        // Get the block from the internal map
        const block = this.timeBlocks.get(blockId);
        if (!block) return;
        
        // Find the task in the block
        const taskIndex = block.tasks.findIndex(t => 
            this.getTaskIdentifier(t) === oldTaskId
        );
        
        if (taskIndex !== -1) {
            // Get the new task
            const newTask = this.view.getTaskManager().getTask(newTaskId);
            if (!newTask) return;
            
            // Replace the task with the new one, preserving the status if it's a TimeBlockTaskIdentity
            const oldTask = block.tasks[taskIndex] as TimeBlockTaskIdentity;
            const updatedTask: TimeBlockTaskIdentity = {
                ...newTask,
                status: TaskStatus.NORMAL // Update status to normal since we've fixed the reference
            };
            
            // Update the task in the block
            block.tasks[taskIndex] = updatedTask;
            
            // Save the updated time blocks to the file
            await this.saveTimeBlocks(this.view.getCurrentDayFile());
            
            // Re-render the block to show the updated task
            this.renderTimeBlock(block, this.view.getTimelineEl());
        }
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

    private getTaskIdentifier(taskIdentity: TaskIdentity | TimeBlockTaskIdentity): string {
        return taskIdentity.identifier;
    }
}